// Dauntless Forever - Dauntless 1.14.7 server loader (dxgi.dll)
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// d1147 server loader for Dauntless 1.14.7 (CL 647472, UE 4.26.2) - milestone 1: boot in server
// mode, open a port, send the world to the player.
//
// This file builds a DLL named dxgi.dll. The game loads dxgi.dll at start, so placing this one
// beside the exe gets our code in before the engine initialises. It forwards every dxgi call to the
// real system DLL.
//
//   - Without the environment variable D1147_SERVER=1 it does nothing else (the normal game is
//   unaffected).
//   - With it, it switches this copy of the game into server mode and, once a world is loaded,
//   opens a UDP
//     listening port (D1147_PORT, default 8780) and sends the world to each connected player.
//
// The approach (run the retail client as a server by driving the networking code that is still in
// the exe) is the one used by the Undaunted project (gwog and contributors, AGPL-3.0); this file is
// a new implementation for the 1.14.7 build, carrying over the fixes of the Undaunted 1.6.2 port
// and of the 2.1.1 loader. All addresses are specific to this one exe; the exe is identified before
// anything is changed, and each patch checks its bytes.
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include "minhook/MinHook.h"

// ---------------------------------------------------------------------------- dxgi forwarding
// Each export forwards to the same function in the system dxgi.dll. Version 2c-fix2 (Oct 13, 2026);
// 2c-fix3/2c-fix4 only add the server-mode sound and mouse fixes further down
// ("keep_quiet_and_off_the_mouse"). 2c-fix followed a crash at address 0 on Windows 11 25H2 (build
// 26200); 2c-fix2 follows its first report from that PC: the system DLL failed to load on the first
// call (error 1168, made during process start-up) and 2c-fix never tried again, so every graphics
// call answered "not available" and the game never showed. Now a failed load is retried on later
// calls (the game's own calls come long after start-up), with two fallbacks: LoadLibraryEx from
// System32, then a copy of the system DLL under another name in %TEMP% (in case Windows refuses a
// second module called dxgi.dll).
//   - the system DLL is loaded on the first call, not inside DllMain (LoadLibrary under the loader
//   lock);
//   - a function the system DLL does not have (Windows changes its private exports) answers a safe
//   "no" instead of
//     jumping to address 0: 0 for the compatibility/void ones, E_NOTIMPL (0x80004001) for the
//     HRESULT ones;
//   - anything missing is written once to %LOCALAPPDATA%\d1147_dxgi.log so the next report names
//   it.
// X(name, value returned when the system DLL lacks the function)
#define DXGI_EXPORTS(X)                                                                            \
    X(ApplyCompatResolutionQuirking, 0)                                                            \
    X(CompatString, 0)                                                                             \
    X(CompatValue, 0)                                                                              \
    X(CreateDXGIFactory, 0x80004001)                                                               \
    X(CreateDXGIFactory1, 0x80004001)                                                              \
    X(CreateDXGIFactory2, 0x80004001)                                                              \
    X(DXGID3D10CreateDevice, 0x80004001)                                                           \
    X(DXGID3D10CreateLayeredDevice, 0x80004001)                                                    \
    X(DXGID3D10GetLayeredDeviceSize, 0)                                                            \
    X(DXGID3D10RegisterLayers, 0x80004001)                                                         \
    X(DXGIDeclareAdapterRemovalSupport, 0x80004001)                                                \
    X(DXGIDisableVBlankVirtualization, 0x80004001)                                                 \
    X(DXGIDumpJournal, 0x80004001)                                                                 \
    X(DXGIGetDebugInterface1, 0x80004001)                                                          \
    X(DXGIReportAdapterConfiguration, 0x80004001)                                                  \
    X(PIXBeginCapture, 0x80004001)                                                                 \
    X(PIXEndCapture, 0x80004001)                                                                   \
    X(PIXGetCaptureState, 0)                                                                       \
    X(SetAppCompatStringPointer, 0)                                                                \
    X(UpdateHMDEmulationStatus, 0)

static void dxgi_note(const char *text) { // plain Win32 only: may run under the loader lock
    wchar_t path[MAX_PATH + 32];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH);
    if (!n || n >= MAX_PATH)
        return;
    wcscat(path, L"\\d1147_dxgi.log");
    HANDLE f = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, 0,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (f == INVALID_HANDLE_VALUE)
        return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    char line[256];
    int len = snprintf(line, sizeof(line), "%04d-%02d-%02d %02d:%02d:%02d pid %lu: %s\r\n", t.wYear,
                       t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond,
                       (unsigned long)GetCurrentProcessId(), text);
    if (len < 0)
        return;
    if (len > (int)sizeof(line) - 1)
        len = (int)sizeof(line) - 1;
    DWORD w;
    WriteFile(f, line, (DWORD)len, &w, 0);
    CloseHandle(f);
}

extern "C" {
#define X(name, fallback) void *d1147_real_##name = 0;
DXGI_EXPORTS(X)
#undef X

static SRWLOCK g_dxgiLock = SRWLOCK_INIT;
static volatile LONG g_dxgiLoaded =
    0;                       // 1 once the system DLL is loaded and the pointers are filled
static LONG g_dxgiTries = 0; // failed attempts so far (each later call retries)
static volatile DWORD g_dxgiOwner = 0; // thread loading the system DLL right now (2c-fix5)
static volatile LONG g_dxgiReentered = 0;

static HMODULE own_module(void) {
    HMODULE m = 0;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)(void *)&own_module, &m);
    return m;
}
// A loaded module is only usable if it is not this DLL itself (asking Windows for "dxgi.dll" can
// hand back ours).
static HMODULE usable(HMODULE m, HMODULE self) {
    if (m && m == self) {
        FreeLibrary(m);
        return 0;
    }
    return m;
}
static HMODULE try_load_system_dxgi(char *how, size_t howLen, DWORD *errs) {
    HMODULE self = own_module();
    wchar_t sys[MAX_PATH + 16];
    UINT n = GetSystemDirectoryW(sys, MAX_PATH);
    if (!n || n >= MAX_PATH) {
        errs[0] = errs[1] = errs[2] = GetLastError();
        return 0;
    }
    wcscat(sys, L"\\dxgi.dll");
    // 0. a DXGI of the player's choosing next to the game exe: dxgi_chain.dll (for example DXVK's
    // dxgi.dll renamed,
    //    with its d3d11.dll beside the exe). GitHub issue #4 (Voidhydra678): Intel Arc's D3D11
    //    driver crashes the game at start, DXVK does not. Nothing changes when the file is not
    //    there.
    {
        wchar_t chain[MAX_PATH + 32];
        DWORD cn = GetModuleFileNameW(0, chain, MAX_PATH);
        if (cn && cn < MAX_PATH) {
            wchar_t *slash = wcsrchr(chain, L'\\');
            if (slash) {
                wcscpy(slash + 1, L"dxgi_chain.dll");
                if (GetFileAttributesW(chain) != INVALID_FILE_ATTRIBUTES) {
                    SetLastError(0);
                    HMODULE c =
                        usable(LoadLibraryExW(chain, 0, LOAD_WITH_ALTERED_SEARCH_PATH), self);
                    if (c) {
                        snprintf(how, howLen, "dxgi_chain.dll next to the exe");
                        return c;
                    }
                    errs[0] = GetLastError();
                }
            }
        }
    }
    // 1. the system DLL by its full path
    SetLastError(0);
    HMODULE m = usable(LoadLibraryExW(sys, 0, 0), self);
    if (m) {
        snprintf(how, howLen, "System32 path");
        return m;
    }
    errs[0] = GetLastError();
    // 2. by name, searching System32 only
    SetLastError(0);
    m = usable(LoadLibraryExW(L"dxgi.dll", 0, LOAD_LIBRARY_SEARCH_SYSTEM32), self);
    if (m) {
        snprintf(how, howLen, "System32 search");
        return m;
    }
    errs[1] = GetLastError();
    // 3. a copy under another name, so no "dxgi.dll is already loaded" rule applies
    wchar_t copy[MAX_PATH + 64];
    DWORD t = GetTempPathW(MAX_PATH, copy);
    if (!t || t >= MAX_PATH) {
        errs[2] = GetLastError();
        return 0;
    }
    wcscat(copy, L"d1147_system_dxgi.dll");
    WIN32_FILE_ATTRIBUTE_DATA a, b;
    BOOL same = GetFileAttributesExW(sys, GetFileExInfoStandard, &a) &&
                GetFileAttributesExW(copy, GetFileExInfoStandard, &b) &&
                a.nFileSizeLow == b.nFileSizeLow && a.nFileSizeHigh == b.nFileSizeHigh &&
                CompareFileTime(&a.ftLastWriteTime, &b.ftLastWriteTime) == 0;
    if (!same)
        CopyFileW(sys, copy, FALSE);
    SetLastError(0);
    m = usable(LoadLibraryExW(copy, 0, LOAD_WITH_ALTERED_SEARCH_PATH), self);
    if (m) {
        snprintf(how, howLen, "copy in TEMP");
        return m;
    }
    errs[2] = GetLastError();
    return 0;
}

void d1147_resolve_dxgi(void) {
    if (g_dxgiLoaded)
        return;
    // 2c-fix5: Windows compatibility shims (apphelp/AcGenral, active when the exe has compatibility
    // settings) call our SetAppCompatStringPointer, and call it AGAIN from inside the LoadLibrary
    // of the system dxgi.dll below, on the same thread. An SRW lock cannot be taken twice by one
    // thread, so the game froze at start-up (0% CPU, empty log). A call made while this thread is
    // already loading the system DLL now answers the fallback instead of waiting.
    if (g_dxgiOwner == GetCurrentThreadId()) {
        if (InterlockedIncrement(&g_dxgiReentered) == 1)
            dxgi_note(
                "dxgi forwarding: called again while loading the system dxgi.dll (compatibility shim); answered without waiting");
        return;
    }
    AcquireSRWLockExclusive(&g_dxgiLock);
    g_dxgiOwner = GetCurrentThreadId();
    if (!g_dxgiLoaded) {
        char how[32] = "", msg[200];
        DWORD errs[3] = {0, 0, 0};
        HMODULE real = try_load_system_dxgi(how, sizeof(how), errs);
        if (!real) {
            LONG k = ++g_dxgiTries;
            if (k <= 5 || k == 20 || k == 100 || k % 1000 == 0) {
                snprintf(
                    msg, sizeof(msg),
                    "dxgi forwarding: attempt %ld, system dxgi.dll did not load (errors %lu / %lu / %lu); will retry on the next call",
                    (long)k, (unsigned long)errs[0], (unsigned long)errs[1],
                    (unsigned long)errs[2]);
                dxgi_note(msg);
            }
        } else {
            if (g_dxgiTries || strcmp(how, "System32 path") != 0) {
                snprintf(msg, sizeof(msg),
                         "dxgi forwarding: system dxgi.dll loaded on attempt %ld (%s)",
                         (long)g_dxgiTries + 1, how);
                dxgi_note(msg);
            }
#define X(name, fallback)                                                                          \
    d1147_real_##name = (void *)GetProcAddress(real, #name);                                       \
    if (!d1147_real_##name) {                                                                      \
        snprintf(msg, sizeof(msg), "dxgi forwarding: system dxgi.dll has no %s, answering %s",     \
                 #name, (fallback) ? "E_NOTIMPL" : "0");                                           \
        dxgi_note(msg);                                                                            \
    }
            DXGI_EXPORTS(X)
#undef X
            InterlockedExchange(&g_dxgiLoaded, 1);
        }
    }
    g_dxgiOwner = 0;
    ReleaseSRWLockExclusive(&g_dxgiLock);
}

// Fast path: jump straight to the system function. Until the system DLL is loaded: save the four
// argument registers, try to load it, restore them and jump. Still not loaded, or the function is
// missing: return the fallback value (the next call tries again).
#define X(name, fallback)                                                                          \
    __declspec(dllexport) __attribute__((naked)) void name(void) {                                 \
        __asm__("movq d1147_real_" #name "(%rip), %rax\n\t"                                        \
                "testq %rax, %rax\n\t"                                                             \
                "jnz 2f\n\t"                                                                       \
                "pushq %rcx\n\t pushq %rdx\n\t pushq %r8\n\t pushq %r9\n\t"                        \
                "subq $40, %rsp\n\t"                                                               \
                "call d1147_resolve_dxgi\n\t"                                                      \
                "addq $40, %rsp\n\t"                                                               \
                "popq %r9\n\t popq %r8\n\t popq %rdx\n\t popq %rcx\n\t"                            \
                "movq d1147_real_" #name "(%rip), %rax\n\t"                                        \
                "testq %rax, %rax\n\t"                                                             \
                "jz 3f\n"                                                                          \
                "2:\n\t jmpq *%rax\n"                                                              \
                "3:\n\t movl $" #fallback ", %eax\n\t ret\n");                                     \
    }
DXGI_EXPORTS(X)
#undef X
}

// ---------------------------------------------------------------------------- log
static FILE *g_log = 0;
static void logf_(const char *fmt, ...) {
    if (!g_log)
        return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(g_log, fmt, ap);
    va_end(ap);
    fputc('\n', g_log);
    fflush(g_log);
}

// ---------------------------------------------------------------------------- 1.14.7 addresses
// (offsets from the exe base) How each one was found is in the project doc "Dauntless 1.14.7 -
// server DLL port map".
namespace A {
// boss health bar (client mode, Oct 19 merge from 2c-fix5 + 4c)
const uintptr_t Part_Component = 0x248;       // AMonsterPartActor -> its UMonsterPartComponent
const uintptr_t PartComp_Actor = 0x520;       // UMonsterPartComponent -> MonsterPartActor
const uintptr_t Actor_InstComponents = 0x1F0; // AActor InstanceComponents (TArray)
const uintptr_t Actor_BPComponents = 0x200;   // AActor BlueprintCreatedComponents (TArray)
// patches
const uintptr_t LoadMapListenCall =
    0x4272A80; // call UWorld::Listen (stub that returns false) inside UEngine::LoadMap
const uintptr_t PreInitA_Client = 0x9F4F12;    // GIsClient = (target bits >> 1) & 1   (13 bytes)
const uintptr_t PreInitA_Server = 0x9F4F1F;    // GIsServer = target bits & 1          (12 bytes)
const uintptr_t PreInitB_ClientImm = 0x9F9439; // immediate of "mov byte [GIsClient], 1"
const uintptr_t PreInitC_ServerImm = 0x9F95F8; // immediate of "mov byte [GIsServer], 0"
const uintptr_t PreInitC_Client = 0x9F95FE;    // mov [GIsClient], r12b (r12b = 1)
// globals
const uintptr_t GIsClient = 0x6E1EAD9;
const uintptr_t GIsServer = 0x6E1EADA;
const uintptr_t GEngine = 0x6FC3CE8;
const uintptr_t GWorld = 0x6FC7F58;
// engine functions
const uintptr_t GetNetMode =
    0x42CC560; // UWorld::InternalGetNetMode: NM_Client whenever a net driver exists
const uintptr_t ActorGetNetMode =
    0x3B61DE0; // AActor::InternalGetNetMode: "standalone" whenever it cannot find its net driver
const uintptr_t ActorGetNetDriver =
    0x3B5DA40; // AActor::GetNetDriver (Undaunted: GetNetDriver_Internal)
const uintptr_t GameEngineTick = 0x3E10AB0; // UGameEngine::Tick(float, bool)
const uintptr_t FNameFromEName = 0x2658800; // FName::FName(EName)
const uintptr_t CreateNamedNetDriver =
    0x425FD30; // UEngine::CreateNamedNetDriver(UWorld*, FName, FName)
const uintptr_t NetDriverSetWorld = 0x3FAD0B0; // UNetDriver::SetWorld(UWorld*)
const uintptr_t SetReplicationDriver =
    0x3FACF60; // UNetDriver::SetReplicationDriver(UReplicationDriver*)
const uintptr_t IsLevelInitForActor =
    0x3F980D0; // UNetDriver::IsLevelInitializedForActor(const AActor*, const UNetConnection*)
const uintptr_t IpNetDriverVTable = 0x504E580;
const uint32_t EName_GameNetDriver = 0x11A;
const uint32_t EName_Actor = 0x66;
const uintptr_t AppendString = 0x2656410; // FName::AppendString(FString&)
const uintptr_t ProcessEvent = 0x2861880; // UObject::ProcessEvent(UFunction*, void* Parms)
const uintptr_t Struct_Super = 0x40;      // UStruct::SuperStruct
const uintptr_t Struct_Children = 0x48;   // UStruct::Children (UField list)
const uintptr_t Field_Next = 0x28;        // UField::Next
// replication (the engine's own "send the world to each player" loop is not in a client build)
const uintptr_t CallPreReplication = 0x3B510D0;   // AActor::CallPreReplication(UNetDriver*)
const uintptr_t SendClientAdjustment = 0x40B8500; // APlayerController::SendClientAdjustment()
const uintptr_t CreateChannelByName =
    0x3F62E90; // UNetConnection::CreateChannelByName(const FName&, EChannelCreateFlags, int32)
const uintptr_t SetChannelActor =
    0x3D8FB20; // UActorChannel::SetChannelActor(AActor*, ESetChannelActorFlags)
const uintptr_t ReplicateActor = 0x3D8A2D0; // UActorChannel::ReplicateActor() -> int64
const uintptr_t WeakPtrAssign = 0x2870E90;  // FWeakObjectPtr::operator=(const UObject*)
const uintptr_t IsNetReady = 0x3F71130;     // UNetConnection::IsNetReady(bool)
// Dauntless functions
const uintptr_t HasFinishedLoading =
    0x1CB1360; // ArchonPlayerController::NativeHasFinishedLoading (interface this)
const uintptr_t SetupPlayerInput = 0x18DFEA0; // AArchonCharacter::SetupPlayerInputComponent
const uintptr_t BountySeasonDates =
    0x19B2970; // UBountyComponent::GetSeasonDates(FDateTime Now, FDateTime&, FDateTime&)
const uintptr_t WeeklySeasonDates = 0x1A0BF90; // UBountyComponent_Weekly::GetSeasonDates
const uintptr_t QueryHuntPassSeason = 0x19120D0;
const uintptr_t SwitchGameWindow = 0x3E103F0; // UGameEngine::SwitchGameWindowToUseGameViewport
                                              // (needs a viewport a server does not have)
const uintptr_t MessageDialogOpen =
    0x2615D20; // FMessageDialog::Open(EAppMsgType, const FText&, const FText*)  //
               // UArchonGameInstance::QueryCurrentHuntPassSeasonData(const FScriptDelegate&)
// object layout (UObject)
const uintptr_t Object_Flags = 0x08;
const uintptr_t Object_Class = 0x10;
const uintptr_t Object_Name = 0x18;
const uintptr_t Object_Outer = 0x20;
const uintptr_t Class_CastFlags = 0xD0;
const uint64_t CastFlag_PlayerController = 0x2000000000ull;
// AActor
const uintptr_t Actor_Bits58 = 0x58; // bit 1 bNetStartup, bit 5 bHidden
const uintptr_t Actor_Bits5C = 0x5C; // bit 3: bActorIsBeingDestroyed
const uintptr_t Actor_RemoteRole = 0x5F;
const uintptr_t Actor_NetDriverName = 0xE8;
const uintptr_t Actor_NetDormancy = 0xF1; // 4 = DORM_Initial
// [Dauntless Forever] owner-only filter (UE 4.26 AActor layout; checked at run time, see
// owner_check)
const uintptr_t Actor_Owner = 0xE0;       // AActor* Owner (just before NetDriverName 0xE8)
const uintptr_t Actor_Instigator = 0x118; // APawn* Instigator
const uint8_t Bits58_OnlyRelevantToOwner =
    0x04; // bit 2 of the 0x58 byte (bit 1 bNetStartup, bit 5 bHidden)
const uint8_t Bits58_AlwaysRelevant = 0x08; // bit 3
const uintptr_t VT_SetActorHiddenInGame = 0x308;
// UWorld / ULevel / FWorldContext / UEngine
const uintptr_t World_NetworkNotify = 0x28; // FNetworkNotify sub-object of UWorld
const uintptr_t World_NetDriver = 0x38;
const uintptr_t World_AuthorityGameMode = 0x118;
const uintptr_t World_Levels = 0x138; // TArray<ULevel*>
const uintptr_t World_GameInstance = 0x180;
const uintptr_t Level_Actors = 0x98;      // TArray<AActor*>
const uintptr_t Level_Bits1F4 = 0x1F4;    // bit 5: bIsVisible
const uintptr_t Engine_WorldList = 0xC38; // TArray<FWorldContext*>
const uintptr_t Context_World = 0x280;
const uintptr_t Context_ActiveNetDrivers =
    0x220; // TArray<FNamedNetDriver> (0x10 each, driver pointer first)
// UNetDriver / UNetConnection / UChannel
const uintptr_t Driver_ClientConnections = 0x90;
const uintptr_t Driver_World = 0x140;
const uintptr_t Driver_NetDriverName = 0x190;
const uintptr_t Driver_Notify = 0x208;
const uintptr_t Driver_ReplicationFrame = 0x2AC;
const uintptr_t Driver_ReplicationDriver = 0x6E8;
const uintptr_t VT_InitListen =
    0x290; // UNetDriver::InitListen(FNetworkNotify*, FURL&, bool, FString&)
const uintptr_t Conn_ViewTarget = 0x90;
const uintptr_t Conn_OwningActor = 0x98;
const uintptr_t Conn_State = 0x134;          // 3 = open
const uintptr_t Conn_ActorChannels = 0x1378; // TMap<TWeakObjectPtr<AActor>, UActorChannel*>
const uintptr_t Channel_Bits = 0x30;         // bit 1: Closing
const uintptr_t Channel_Actor = 0x70;
const uintptr_t ActorChannel_Bits = 0x90; // bit 1: bForceCompareProperties
// APlayerController
const uintptr_t PC_Pawn = 0x250;
const uintptr_t PC_PlayerCameraManager = 0x2B8;
const uintptr_t PC_IsLocalFlag = 0x57C; // bIsLocalPlayerController
const uintptr_t PCM_ViewTargetActor = 0xE70;
} // namespace A

static uintptr_t g_base = 0;
static int g_port = 8780;
template <class T> static T &at(uintptr_t addr) { return *(T *)addr; }

struct FString {
    wchar_t *Data;
    int32_t Num;
    int32_t Max;
};
struct TArrayRaw {
    void **Data;
    int32_t Num;
    int32_t Max;
};

// Name of an engine object as text (the small string it allocates is left to the engine).
static const char *name_of(void *obj, char *out, int n) {
    out[0] = 0;
    if (!obj) {
        snprintf(out, n, "(none)");
        return out;
    }
    FString s = {0, 0, 0};
    ((void (*)(void *, FString *))(g_base + A::AppendString))(
        (void *)((uintptr_t)obj + A::Object_Name), &s);
    if (s.Data && s.Num > 0)
        WideCharToMultiByte(CP_UTF8, 0, s.Data, -1, out, n, 0, 0);
    out[n - 1] = 0;
    return out;
}

// ---------------------------------------------------------------------------- crash notes
static volatile LONG g_inHandler = 0;
static int g_crashNotes = 0;
static DWORD g_gameThread = 0;
static void where(uintptr_t addr, char *out, int n) {
    HMODULE m = 0;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)addr, &m) &&
        m) {
        if ((uintptr_t)m == g_base) {
            snprintf(out, n, "exe+0x%llX", (unsigned long long)(addr - g_base));
            return;
        }
        char path[MAX_PATH];
        path[0] = 0;
        GetModuleFileNameA(m, path, sizeof(path));
        const char *b = strrchr(path, '\\');
        snprintf(out, n, "%s+0x%llX", b ? b + 1 : path, (unsigned long long)(addr - (uintptr_t)m));
        return;
    }
    snprintf(out, n, "0x%llX", (unsigned long long)addr);
}
static bool readable(uintptr_t p, size_t n) {
    if (p < 0x10000)
        return false;
    MEMORY_BASIC_INFORMATION mbi;
    if (!VirtualQuery((void *)p, &mbi, sizeof(mbi)) || mbi.State != MEM_COMMIT)
        return false;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))
        return false;
    return p + n <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
}

// A direct call into the game made by this loader can be fenced: if it hits a bad pointer, the
// handler puts the thread back where the fence was set up and the call reports failure.
static CONTEXT g_guardCtx;
static volatile LONG g_guardOn = 0, g_guardHit = 0;
__attribute__((noinline)) static bool guarded(void (*fn)(void *), void *arg) {
    g_guardHit = 0;
    RtlCaptureContext(&g_guardCtx);
    if (g_guardHit) {
        g_guardOn = 0;
        return false;
    } // arrived here from the exception handler
    g_guardOn = 1;
    fn(arg);
    g_guardOn = 0;
    return true;
}

// Writes where a crash happened into our log, then lets the game's own crash handling carry on.
static LONG CALLBACK on_exception(EXCEPTION_POINTERS *ep) {
    DWORD code = ep->ExceptionRecord->ExceptionCode;
    bool interesting = code == 0xC0000005 || code == 0xC000001D || code == 0xC0000094 ||
                       code == 0xC0000096 || code == 0x80000003 || code == 0xC06D007E ||
                       code == 0xC06D007F;
    if (!interesting)
        return EXCEPTION_CONTINUE_SEARCH;
    if (InterlockedCompareExchange(&g_inHandler, 1, 0) != 0)
        return EXCEPTION_CONTINUE_SEARCH;

    uintptr_t faultAt = (uintptr_t)ep->ExceptionRecord->ExceptionAddress;
    bool av = code == 0xC0000005 && ep->ExceptionRecord->NumberParameters >= 2;
    uintptr_t badAddr = av ? (uintptr_t)ep->ExceptionRecord->ExceptionInformation[1] : 0;

    uintptr_t frames[64];
    int nframes = 0;
    CONTEXT c = *ep->ContextRecord;
    for (int i = 0; i < 64; i++) {
        DWORD64 imageBase = 0;
        PRUNTIME_FUNCTION rf = RtlLookupFunctionEntry(c.Rip, &imageBase, 0);
        if (rf) {
            void *handlerData = 0;
            DWORD64 establisher = 0;
            RtlVirtualUnwind(0, imageBase, c.Rip, rf, &c, &handlerData, &establisher, 0);
        } else {
            if (!readable((uintptr_t)c.Rsp, 8))
                break;
            c.Rip = *(DWORD64 *)c.Rsp;
            c.Rsp += 8;
        }
        if (!c.Rip)
            break;
        frames[nframes++] = (uintptr_t)c.Rip;
    }

    char w[320];
    bool fenced = g_guardOn && av && GetCurrentThreadId() == g_gameThread;
    if (g_crashNotes < 4 || fenced) {
        g_crashNotes++;
        where(faultAt, w, sizeof(w));
        if (av)
            logf_("EXCEPTION 0x%08lX at %s (%s address 0x%llX) thread %lu%s", code, w,
                  ep->ExceptionRecord->ExceptionInformation[0] == 1   ? "writing"
                  : ep->ExceptionRecord->ExceptionInformation[0] == 8 ? "executing"
                                                                      : "reading",
                  (unsigned long long)badAddr, GetCurrentThreadId(),
                  GetCurrentThreadId() == g_gameThread ? " (game thread)" : "");
        else
            logf_("EXCEPTION 0x%08lX at %s thread %lu", code, w, GetCurrentThreadId());
        for (int i = 0; i < nframes && i < 40; i++) {
            where(frames[i], w, sizeof(w));
            logf_("   called from %s", w);
        }
    }
    if (fenced) {
        logf_(
            "   ... inside a fenced call made by this loader: the call is abandoned and the server carries on");
        g_guardOn = 0;
        g_guardHit = 1;
        *ep->ContextRecord = g_guardCtx;
        InterlockedExchange(&g_inHandler, 0);
        return EXCEPTION_CONTINUE_EXECUTION;
    }
    InterlockedExchange(&g_inHandler, 0);
    return EXCEPTION_CONTINUE_SEARCH;
}

static bool patch(uintptr_t rva, const uint8_t *expect, const uint8_t *repl, size_t n,
                  const char *what) {
    uint8_t *p = (uint8_t *)(g_base + rva);
    if (memcmp(p, repl, n) == 0) {
        logf_("patch %-34s already applied", what);
        return true;
    }
    if (memcmp(p, expect, n) != 0) {
        logf_("patch %-34s SKIPPED: bytes at +0x%llX do not match this build", what,
              (unsigned long long)rva);
        return false;
    }
    DWORD old = 0;
    if (!VirtualProtect(p, n, PAGE_EXECUTE_READWRITE, &old)) {
        logf_("patch %-34s FAILED: VirtualProtect error %lu", what, GetLastError());
        return false;
    }
    memcpy(p, repl, n);
    VirtualProtect(p, n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), p, n);
    logf_("patch %-34s ok", what);
    return true;
}

static bool hook(uintptr_t rva, const uint8_t *expect, size_t n, void *detour, void **orig,
                 const char *what) {
    if (expect && memcmp((void *)(g_base + rva), expect, n) != 0) {
        logf_("hook  %-34s SKIPPED: bytes at +0x%llX do not match", what, (unsigned long long)rva);
        return false;
    }
    MH_STATUS s = MH_CreateHook((void *)(g_base + rva), detour, orig);
    if (s == MH_OK)
        s = MH_EnableHook((void *)(g_base + rva));
    logf_("hook  %-34s %s", what, s == MH_OK ? "ok" : "FAILED");
    return s == MH_OK;
}

// ---------------------------------------------------------------------------- net mode
// Every question "what kind of game is this" answers "dedicated server" (1). The actor-level
// version answers "standalone" when the actor cannot find its net driver, and a player's controller
// that hears that once marks itself as the LOCAL player's for good, after which the server runs the
// player's client-side logic itself (2.1.1: a 120-second "did I finish loading" timer that dropped
// the player, conversations that never opened).
static int (*orig_GetNetMode)(void *) = 0;
static int hook_GetNetMode(void *) { return 1; }
static int (*orig_ActorGetNetMode)(void *) = 0;
static int hook_ActorGetNetMode(void *) { return 1; }

// ---------------------------------------------------------------------------- Undaunted 1.6.2
// fixes
static void *g_driver = 0;
static void *(*orig_ActorGetNetDriver)(void *) = 0;
static void *hook_ActorGetNetDriver(void *actor) { // an actor that cannot find its driver gets ours
    void *d = orig_ActorGetNetDriver(actor);
    return d ? d : g_driver;
}
static void (*orig_SetReplicationDriver)(void *, void *) = 0;
static void hook_SetReplicationDriver(void *driver, void *) {
    orig_SetReplicationDriver(driver, 0);
} // this loader replicates itself
static bool (*orig_IsLevelInitForActor)(void *, void *, void *) = 0;
static bool hook_IsLevelInitForActor(void *, void *, void *) { return true; }
static int hook_IsNetReady(void *, bool) { return 1; } // never throttle: everything is on this PC
static void *orig_IsNetReady = 0;

static long g_forceReady = 0;
static bool (*orig_HasFinishedLoading)(void *) = 0;
static bool hook_HasFinishedLoading(void *self) {
    bool r = orig_HasFinishedLoading(self);
    if (!r && ++g_forceReady <= 5)
        logf_("player controller still loading on the server side: answered 'finished' (%ld)",
              g_forceReady);
    return true;
}
static void *orig_SetupPlayerInput = 0;
static long g_inputSkips = 0;
static void hook_SetupPlayerInput(void *,
                                  void *) { // input bindings exist only on the player's own PC
    if (++g_inputSkips <= 3)
        logf_("skipped SetupPlayerInputComponent on the server");
}

// Bounty season dates. With no live season the server cannot place the bounty and challenge windows
// and sends the player back to the main menu ("ServerInitializeBounties() - failed to get season
// dates"). The game's own answer is kept whenever it has one. Base component: wide window, as in
// the 1.6.2 port. Weekly component: a short window around today, because an endless season made the
// weekly-challenge draft loop forever on 2.1.1.
static int64_t ue_now_ticks() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime; // 100 ns since 1601-01-01
    return (int64_t)(t + 504911232000000000ull); // 100 ns since 0001-01-01 (FDateTime ticks)
}
static bool (*orig_BountySeasonDates)(void *, void *, int64_t *, int64_t *) = 0;
static bool hook_BountySeasonDates(void *c, void *now, int64_t *s, int64_t *e) {
    if (orig_BountySeasonDates(c, now, s, e))
        return true;
    *s = 637450560000000000LL; // 2021-01-01
    *e = 657647424000000000LL; // 2085-01-01
    static long n = 0;
    if (++n <= 3)
        logf_("bounty season dates: no current season, using 2021-2085");
    return true;
}
static bool (*orig_WeeklySeasonDates)(void *, void *, int64_t *, int64_t *) = 0;
static bool hook_WeeklySeasonDates(void *c, void *now, int64_t *s, int64_t *e) {
    if (orig_WeeklySeasonDates(c, now, s, e))
        return true;
    const int64_t day = 864000000000LL;
    int64_t t = ue_now_ticks();
    *s = t - 7 * day;
    *e = t + 12 * 7 * day;
    static long n = 0;
    if (++n <= 3)
        logf_("weekly bounty season dates: no current season, using last week to 12 weeks ahead");
    return true;
}

// The game window is switched over to show the game's view once the first map is up. A server copy
// has no view (no viewport client), and the switch then writes through a null pointer (crash of Oct
// 11, 21:49).
static void *orig_SwitchGameWindow = 0;
static void hook_SwitchGameWindow(void *) {
    static long n = 0;
    if (++n <= 2)
        logf_("skipped switching the game window to the game view (no view on a server)");
}

// Message boxes would wait for someone to click them (the font warnings at start-up did). On the
// server each one is written to this log and answered the way the engine answers in unattended
// mode.
static int (*orig_MessageDialogOpen)(int, void *, void *) = 0;
static int hook_MessageDialogOpen(int type, void *, void *) {
    static const int answer[7] = {5 /*Ok*/, 0 /*No*/, 4 /*Cancel*/, 4, 4, 0 /*No*/, 1 /*Yes*/};
    int a = (type >= 0 && type <= 6) ? answer[type] : 1;
    char w[96];
    where((uintptr_t)__builtin_return_address(0), w, sizeof(w));
    static long n = 0;
    if (++n <= 20)
        logf_("message box (type %d) suppressed, answered %d; asked from %s", type, a, w);
    return a;
}

// ---------------------------------------------------------------------------- replication
// The same job Undaunted's Networking.cpp does for 1.4.4 / 1.6.2: every tick, for every connected
// player, make sure each networked actor has a channel and let the engine send what changed.
static void **g_consider = 0;
static int g_considerCap = 0;
static uint64_t g_actorChannelName = 0;
static long g_repOpened = 0, g_repSentTick = 0, g_repFailed = 0, g_repTicks = 0;
static double g_repMsTotal = 0;
static bool g_replicate = true;
// [Dauntless Forever] Owner-only actors (a player's own inventory, loadout, bounties and similar)
// must only go to that player, as in 1.6.2's Networking.cpp (Oct 13): sent to everyone, they kept
// the second player in a server from ever finishing loading. Skip bOnlyRelevantToOwner &&
// !bAlwaysRelevant actors unless the connection's controller or pawn is in the actor's Owner chain
// or is its Instigator. Env D1147_OWNER_ONLY=0 turns it off; it also turns itself off if a player's
// character is not owned by its controller (the offsets would be wrong).
static int g_ownerOnly = 1; // 1 on, 0 off
static bool g_ownerChecked = false;
static long g_ownerSkipped = 0;
static void owner_check(void *pc, void *pawn) {
    if (g_ownerChecked || !pawn || g_ownerOnly != 1)
        return;
    g_ownerChecked = true;
    void *po = at<void *>((uintptr_t)pawn + A::Actor_Owner);
    if (po != pc) {
        g_ownerOnly = 0;
        logf_(
            "owner-only filter OFF: a player's character is not owned by its controller (got %p, want %p); every actor goes to every player",
            po, pc);
    } else
        logf_("owner-only filter: check passed (character owned by its controller)");
}
static bool owner_only_skip(void *a, void *pc, void *pawn) {
    if (g_ownerOnly != 1)
        return false;
    uint8_t b = at<uint8_t>((uintptr_t)a + A::Actor_Bits58);
    if (!(b & A::Bits58_OnlyRelevantToOwner) || (b & A::Bits58_AlwaysRelevant))
        return false;
    if (pawn && at<void *>((uintptr_t)a + A::Actor_Instigator) == pawn)
        return false;
    void *o = a;
    for (int i = 0; o && i < 8; i++) {
        if (o == pc || (pawn && o == pawn))
            return false;
        o = at<void *>((uintptr_t)o + A::Actor_Owner);
    }
    return true;
}

// UNetConnection::FindActorChannelRef is inlined everywhere in this build: the same lookup, written
// out.
static void *find_actor_channel(void *conn, uint64_t weak) {
    uintptr_t m = (uintptr_t)conn + A::Conn_ActorChannels;
    if (at<int32_t>(m + 0x08) == at<int32_t>(m + 0x34))
        return 0; // no elements (all slots free)
    int32_t hashSize = at<int32_t>(m + 0x48);
    if (hashSize <= 0)
        return 0;
    int32_t *buckets = at<int32_t *>(m + 0x40) ? at<int32_t *>(m + 0x40) : (int32_t *)(m + 0x38);
    int64_t h =
        ((int64_t)(int32_t)(weak & 0xFFFFFFFF) ^ (int64_t)(int32_t)(weak >> 32)) & (hashSize - 1);
    uint8_t *data = at<uint8_t *>(m);
    int32_t idx = buckets[h];
    for (int guard = 0; idx != -1 && guard < 100000; guard++) {
        uint8_t *el = data + (int64_t)idx * 0x18;
        if (*(uint64_t *)el == weak)
            return *(void **)(el + 8);
        idx = *(int32_t *)(el + 0x10);
    }
    return 0;
}

static void replicate_one(void *conn, void *actor) {
    uint64_t weak = 0;
    ((void (*)(void *, void *))(g_base + A::WeakPtrAssign))(&weak, actor);
    void *ch = find_actor_channel(conn, weak);
    if (!ch) {
        uint64_t name = g_actorChannelName;
        ch = ((void *(*)(void *, uint64_t *, uint32_t, int32_t))(g_base + A::CreateChannelByName))(
            conn, &name, 2 /*opened locally*/, -1);
        if (!ch) {
            g_repFailed++;
            return;
        }
        ((void (*)(void *, void *, uint32_t))(g_base + A::SetChannelActor))(ch, actor, 0);
        g_repOpened++;
    }
    if (at<uint32_t>((uintptr_t)ch + A::Channel_Bits) & 2)
        return; // closing
    if (!at<void *>((uintptr_t)ch + A::Channel_Actor))
        return;
    at<uint32_t>((uintptr_t)ch + A::ActorChannel_Bits) |= 2; // compare every property
    int64_t bits = ((int64_t (*)(void *))(g_base + A::ReplicateActor))(ch);
    if (bits > 0)
        g_repSentTick++;
}

static void replicate_tick(void *world, void *driver) {
    TArrayRaw &conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    if (conns.Num <= 0 || !conns.Data)
        return;
    void *ready[8];
    int nready = 0;
    for (int i = 0; i < conns.Num && nready < 8; i++) {
        void *c = conns.Data[i];
        if (!c)
            continue;
        if (at<uint32_t>((uintptr_t)c + A::Conn_State) != 3)
            continue;
        if (!at<void *>((uintptr_t)c + A::Conn_OwningActor))
            continue;
        ready[nready++] = c;
    }
    if (!nready)
        return;

    LARGE_INTEGER t0, t1, freq;
    QueryPerformanceCounter(&t0);
    if (!g_actorChannelName) {
        ((void *(*)(void *, uint32_t))(g_base + A::FNameFromEName))(&g_actorChannelName,
                                                                    A::EName_Actor);
        g_actorChannelName &= 0xFFFFFFFFull;
    }
    at<uint32_t>((uintptr_t)driver + A::Driver_ReplicationFrame)++;
    uint64_t driverName = at<uint64_t>((uintptr_t)driver + A::Driver_NetDriverName);

    // 1. which actors are networked at all
    int n = 0;
    TArrayRaw &levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    for (int li = 0; li < levels.Num; li++) {
        void *level = levels.Data[li];
        if (!level)
            continue;
        if (!(at<uint8_t>((uintptr_t)level + A::Level_Bits1F4) & 0x20))
            continue; // level not visible yet
        TArrayRaw &actors = at<TArrayRaw>((uintptr_t)level + A::Level_Actors);
        for (int ai = 0; ai < actors.Num; ai++) {
            void *a = actors.Data[ai];
            if (!a)
                continue;
            if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000)
                continue; // being garbage collected
            if (at<uint8_t>((uintptr_t)a + A::Actor_Bits5C) & 0x08)
                continue; // being destroyed
            if (at<uint8_t>((uintptr_t)a + A::Actor_RemoteRole) == 0)
                continue; // not networked
            if (at<uint64_t>((uintptr_t)a + A::Actor_NetDriverName) != driverName)
                continue;
            if ((at<uint8_t>((uintptr_t)a + A::Actor_Bits58) & 0x02) &&
                at<uint8_t>((uintptr_t)a + A::Actor_NetDormancy) == 4)
                continue; // unchanged map actor: the game already has it
            ((void (*)(void *, void *))(g_base + A::CallPreReplication))(a, driver);
            if (n >= g_considerCap) {
                int cap = g_considerCap ? g_considerCap * 2 : 4096;
                void **bigger = (void **)HeapAlloc(GetProcessHeap(), 0, sizeof(void *) * cap);
                if (!bigger)
                    break;
                if (g_consider) {
                    memcpy(bigger, g_consider, sizeof(void *) * n);
                    HeapFree(GetProcessHeap(), 0, g_consider);
                }
                g_consider = bigger;
                g_considerCap = cap;
            }
            g_consider[n++] = a;
        }
    }
    g_repSentTick = 0;

    // 2. each player
    for (int ci = 0; ci < nready; ci++) {
        void *conn = ready[ci];
        void *pc = at<void *>((uintptr_t)conn + A::Conn_OwningActor);
        void *view = pc;
        void *cam = at<void *>((uintptr_t)pc + A::PC_PlayerCameraManager);
        void *pawn = at<void *>((uintptr_t)pc + A::PC_Pawn);
        if (cam && at<void *>((uintptr_t)cam + A::PCM_ViewTargetActor))
            view = at<void *>((uintptr_t)cam + A::PCM_ViewTargetActor);
        else if (pawn)
            view = pawn;
        at<void *>((uintptr_t)conn + A::Conn_ViewTarget) = view;
        ((void (*)(void *))(g_base + A::SendClientAdjustment))(pc);
        replicate_one(conn, pc); // the player's own controller first
        owner_check(pc, pawn);
        for (int i = 0; i < n; i++) {
            void *a = g_consider[i];
            if (a == pc)
                continue;
            void *cls = at<void *>((uintptr_t)a + A::Object_Class);
            if (cls &&
                (at<uint64_t>((uintptr_t)cls + A::Class_CastFlags) & A::CastFlag_PlayerController))
                continue; // other players' controllers
            if (nready > 1 && owner_only_skip(a, pc, pawn)) {
                g_ownerSkipped++;
                continue;
            } // another player's own actors
            replicate_one(conn, a);
        }
    }
    QueryPerformanceCounter(&t1);
    QueryPerformanceFrequency(&freq);
    double ms = (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / (double)freq.QuadPart;
    g_repMsTotal += ms;
    g_repTicks++;
    if (g_repTicks == 1 || g_repTicks == 10 || g_repTicks == 100 || g_repTicks % 600 == 0) {
        logf_(
            "replication: %d player(s), %d networked actors, %ld sent this tick, %ld channels opened so far, %ld failed, %ld owner-only skipped, this tick %.1f ms, average %.1f ms",
            nready, n, g_repSentTick, g_repOpened, g_repFailed, g_ownerSkipped, ms,
            g_repMsTotal / (double)g_repTicks);
    }
}

// ---------------------------------------------------------------------------- stamina
// (Undaunted 1.6.2: TickStamina) The player character's stamina is advanced by its blueprint
// function TickStamina(Where, Whom); nothing calls it on a server copy, so stamina never refills
// and the player cannot sprint. Called here every tick for each player's character, with Where =
// Both (2), Whom = All (5), as Undaunted does.
static bool name_is(void *obj, const wchar_t *want) {
    FString s = {0, 0, 0};
    ((void (*)(void *, FString *))(g_base + A::AppendString))(
        (void *)((uintptr_t)obj + A::Object_Name), &s);
    return s.Data && s.Num > 0 && wcscmp(s.Data, want) == 0;
}
static void *find_function(void *cls, const wchar_t *name) {
    for (int depth = 0; cls && depth < 32;
         depth++, cls = at<void *>((uintptr_t)cls + A::Struct_Super)) {
        for (void *f = at<void *>((uintptr_t)cls + A::Struct_Children); f;
             f = at<void *>((uintptr_t)f + A::Field_Next))
            if (name_is(f, name))
                return f;
    }
    return 0;
}
static void *g_staminaClass = 0;
static void *g_staminaFn = 0;
static long g_staminaCalls = 0;
static bool g_stamina = true;
static void stamina_tick(void *driver) {
    TArrayRaw &conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    for (int i = 0; conns.Data && i < conns.Num && i < 8; i++) {
        void *c = conns.Data[i];
        if (!c)
            continue;
        if (at<uint32_t>((uintptr_t)c + A::Conn_State) != 3)
            continue;
        void *pc = at<void *>((uintptr_t)c + A::Conn_OwningActor);
        if (!pc)
            continue;
        void *pawn = at<void *>((uintptr_t)pc + A::PC_Pawn);
        if (!pawn)
            continue;
        if (at<uint32_t>((uintptr_t)pawn + A::Object_Flags) & 0x60000000)
            continue;
        void *cls = at<void *>((uintptr_t)pawn + A::Object_Class);
        if (cls != g_staminaClass) {
            g_staminaClass = cls;
            g_staminaFn = find_function(cls, L"TickStamina");
            char a[128];
            logf_("stamina: character class %s %s", name_of(cls, a, sizeof(a)),
                  g_staminaFn ? "has TickStamina; the server ticks it" : "has NO TickStamina");
        }
        if (!g_staminaFn)
            continue;
        uint8_t parms[2] = {2 /*Both*/, 5 /*All*/};
        ((void (*)(void *, void *, void *))(g_base + A::ProcessEvent))(pawn, g_staminaFn, parms);
        g_staminaCalls++;
    }
}

// ---------------------------------------------------------------------------- listening
struct FURL {
    FString Protocol;
    FString Host;
    int32_t Port;
    int32_t Valid;
    FString Map;
    FString RedirectUrl;
    void *OpData;
    int32_t OpNum;
    int32_t OpMax;
    FString Portal;
};

static int g_state = 0; // 0 waiting for a world, 1 world seen, 2 listening, 3 failed
static ULONGLONG g_worldSeenAt = 0;
static void *g_worldSeen = 0;
static int32_t g_lastConns = 0;

static void *context_of(void *engine, void *world) {
    TArrayRaw &list = at<TArrayRaw>((uintptr_t)engine + A::Engine_WorldList);
    for (int i = 0; list.Data && i < list.Num && i < 32; i++) {
        void *ctx = list.Data[i];
        if (ctx && at<void *>((uintptr_t)ctx + A::Context_World) == world)
            return ctx;
    }
    return 0;
}

static void do_listen(void *world) {
    void *engine = at<void *>(g_base + A::GEngine);
    logf_("listen: engine %p world %p", engine, world);
    if (!engine) {
        logf_("listen: no engine object");
        g_state = 3;
        return;
    }

    uint64_t name = 0;
    ((void *(*)(void *, uint32_t))(g_base + A::FNameFromEName))(&name, A::EName_GameNetDriver);
    name &= 0xFFFFFFFFull; // comparison index, number 0
    uint8_t created = ((uint8_t (*)(void *, void *, uint64_t, uint64_t))(
        g_base + A::CreateNamedNetDriver))(engine, world, name, name);
    logf_("listen: net driver create = %d", (int)created);

    void *ctx = context_of(engine, world);
    void *driver = 0;
    if (ctx) {
        void **arr = at<void **>((uintptr_t)ctx + A::Context_ActiveNetDrivers);
        int32_t n = at<int32_t>((uintptr_t)ctx + A::Context_ActiveNetDrivers + 8);
        logf_("listen: world context %p has %d active net driver(s)", ctx, n);
        for (int i = 0; i < n && i < 16; i++) {
            void *d = arr[i * 2];
            if (!d)
                continue;
            uintptr_t vt = at<uintptr_t>((uintptr_t)d) - g_base;
            char cn[128];
            logf_("listen:   driver %p class %s vtable +0x%llX%s name-id 0x%X", d,
                  name_of(at<void *>((uintptr_t)d + A::Object_Class), cn, sizeof(cn)),
                  (unsigned long long)vt, vt == A::IpNetDriverVTable ? " (IpNetDriver)" : "",
                  at<uint32_t>((uintptr_t)d + A::Driver_NetDriverName));
            if (at<uint32_t>((uintptr_t)d + A::Driver_NetDriverName) == (uint32_t)name)
                driver = d;
        }
    } else
        logf_("listen: no world context found for this world");
    if (!driver) {
        logf_("listen: no game net driver was created; stopping here");
        g_state = 3;
        return;
    }

    ((void (*)(void *, void *))(g_base + A::NetDriverSetWorld))(driver, world);

    FURL url;
    memset(&url, 0, sizeof(url));
    url.Port = g_port;
    url.Valid = 1;
    FString err = {0, 0, 0};
    void **vt = at<void **>((uintptr_t)driver);
    bool ok = ((bool (*)(void *, void *, FURL *, bool, FString *))vt[A::VT_InitListen / 8])(
        driver, (void *)((uintptr_t)world + A::World_NetworkNotify), &url, false, &err);
    logf_("listen: InitListen on port %d = %d", g_port, (int)ok);
    if (err.Data && err.Num > 0) {
        char m[512];
        WideCharToMultiByte(CP_UTF8, 0, err.Data, -1, m, sizeof(m), 0, 0);
        logf_("listen: engine says: %s", m);
    }
    if (!ok) {
        g_state = 3;
        return;
    }

    ((void (*)(void *, void *))(g_base + A::NetDriverSetWorld))(driver, world);
    at<void *>((uintptr_t)world + A::World_NetDriver) = driver;
    g_driver = driver;
    g_state = 2;
    logf_("replication driver object on the net driver: %p (expected: none)",
          at<void *>((uintptr_t)driver + A::Driver_ReplicationDriver));
    logf_("LISTENING on UDP port %d", g_port);
}

// ---------------------------------------------------------------------------- hidden players
// (2.1.1 lesson) If the server marks a connected player's character hidden (the game does that on
// the player's own screen while talking to a townsperson), the mark is sent to the player and
// nothing takes it back. Such requests are logged and not carried out; a character that ends up
// hidden anyway is shown again after a few seconds.
static void (*orig_SetHidden)(void *, bool) = 0;
static bool g_hideHooked = false;
static long g_hideNotes = 0, g_localFlagNotes = 0;
static bool is_player_pawn(void *actor) {
    if (!g_driver || !actor)
        return false;
    TArrayRaw &conns = at<TArrayRaw>((uintptr_t)g_driver + A::Driver_ClientConnections);
    for (int i = 0; conns.Data && i < conns.Num && i < 64; i++) {
        void *c = conns.Data[i];
        if (!c)
            continue;
        void *pc = at<void *>((uintptr_t)c + A::Conn_OwningActor);
        if (!pc)
            continue;
        if (at<void *>((uintptr_t)pc + A::PC_Pawn) == actor)
            return true;
    }
    return false;
}
static void hook_SetHidden(void *actor, bool hide) {
    if (hide && GetCurrentThreadId() == g_gameThread && is_player_pawn(actor)) {
        char nm[128];
        if (++g_hideNotes <= 20)
            logf_("hide: the server was asked to HIDE the player's character '%s' - not done",
                  name_of(actor, nm, sizeof(nm)));
        return;
    }
    orig_SetHidden(actor, hide);
}
struct HideSlot {
    void *pawn;
    bool hidden;
    ULONGLONG since;
};
static HideSlot g_hideSlots[8];
static void player_watch(void *driver) {
    TArrayRaw &conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    ULONGLONG now = GetTickCount64();
    for (int i = 0; conns.Data && i < conns.Num && i < 8; i++) {
        void *c = conns.Data[i];
        if (!c)
            continue;
        void *pc = at<void *>((uintptr_t)c + A::Conn_OwningActor);
        if (!pc)
            continue;
        if (at<uint8_t>((uintptr_t)pc + A::PC_IsLocalFlag)) {
            char nm[128];
            if (++g_localFlagNotes <= 10)
                logf_(
                    "net mode: controller '%s' had marked itself as a LOCAL player's controller; mark removed",
                    name_of(pc, nm, sizeof(nm)));
            at<uint8_t>((uintptr_t)pc + A::PC_IsLocalFlag) = 0;
        }
        void *pawn = at<void *>((uintptr_t)pc + A::PC_Pawn);
        HideSlot &s = g_hideSlots[i];
        if (!pawn) {
            s.pawn = 0;
            continue;
        }
        if (at<uint32_t>((uintptr_t)pawn + A::Object_Flags) & 0x60000000)
            continue;
        if (!g_hideHooked) {
            g_hideHooked = true;
            uintptr_t fn = (uintptr_t)at<void **>((uintptr_t)pawn)[A::VT_SetActorHiddenInGame / 8];
            if (fn > g_base && fn < g_base + 0x5000000) {
                MH_STATUS st =
                    MH_CreateHook((void *)fn, (void *)hook_SetHidden, (void **)&orig_SetHidden);
                if (st == MH_OK)
                    st = MH_EnableHook((void *)fn);
                logf_(
                    "hide: watching requests to hide a player's character (function at exe+0x%llX, hook %d)",
                    (unsigned long long)(fn - g_base), (int)st);
                if (st != MH_OK)
                    orig_SetHidden = 0;
            }
        }
        bool hidden = (at<uint8_t>((uintptr_t)pawn + A::Actor_Bits58) & 0x20) != 0;
        char nm[128];
        if (pawn != s.pawn) {
            s.pawn = pawn;
            s.hidden = hidden;
            s.since = now;
            logf_("player's character '%s' is %s on the server", name_of(pawn, nm, sizeof(nm)),
                  hidden ? "HIDDEN" : "visible");
            continue;
        }
        if (hidden != s.hidden) {
            s.hidden = hidden;
            s.since = now;
            logf_("player's character '%s' became %s on the server", name_of(pawn, nm, sizeof(nm)),
                  hidden ? "HIDDEN" : "visible");
        }
        if (hidden && orig_SetHidden && now - s.since > 4000) {
            logf_("hide: still hidden after 4 seconds; showing the character again");
            orig_SetHidden(pawn, false);
            s.since = now;
        }
    }
}

// ---------------------------------------------------------------------------- progression
// configuration (2.1.1 lesson) A player's progression data waits for the game-wide progression
// configuration, which the game asks the backend for from its menus; a server has no menus, so it
// is asked for here (twice: at listen and 20 seconds later).
static bool g_progOk = true;
static int g_progAsks = 0;
static ULONGLONG g_progAskAt = 0;
static void prog_ask(void *gi) {
    uint64_t noDelegate[2] = {
        0, 0}; // "tell nobody in particular": the game instance announces the result itself
    ((void (*)(void *, void *))(g_base + A::QueryHuntPassSeason))(gi, noDelegate);
}
static void progression_tick(void *world) {
    if (!g_progOk || g_progAsks >= 2)
        return;
    ULONGLONG now = GetTickCount64();
    if (g_progAsks == 1 && now - g_progAskAt < 20000)
        return;
    void *gi = at<void *>((uintptr_t)world + A::World_GameInstance);
    if (!gi)
        return;
    char a[128], b[128];
    g_progAsks++;
    g_progAskAt = now;
    logf_(
        "progression: asking the backend for the progression configuration (request %d, game instance '%s' of class %s)",
        g_progAsks, name_of(gi, a, sizeof(a)),
        name_of(at<void *>((uintptr_t)gi + A::Object_Class), b, sizeof(b)));
    if (!guarded(prog_ask, gi)) {
        logf_("progression: the request could not be made; leaving progression alone");
        g_progOk = false;
    }
}

#include "equipment_bridge.h"
#include "live_refresh.h"

// ---------------------------------------------------------------------------- the engine tick
static long g_ticks = 0;
static void (*orig_Tick)(void *, float, bool) = 0;
static void hook_Tick(void *engine, float dt, bool idle) {
    orig_Tick(engine, dt, idle);
    g_ticks++;
    void *world = at<void *>(g_base + A::GWorld);
    if (g_ticks == 1)
        logf_("first engine tick; world %p", world);
    if (!world)
        return;
    if (world != g_worldSeen) {
        g_worldSeen = world;
        g_worldSeenAt = GetTickCount64();
        char a[256], b[256], c[256];
        void *gm = at<void *>((uintptr_t)world + A::World_AuthorityGameMode);
        logf_("world is live: %p (tick %ld)  world '%s' in package '%s'", world, g_ticks,
              name_of(world, a, sizeof(a)),
              name_of(at<void *>((uintptr_t)world + A::Object_Outer), b, sizeof(b)));
        logf_("   game mode: %s   flags: client %d server %d",
              gm ? name_of(at<void *>((uintptr_t)gm + A::Object_Class), c, sizeof(c)) : "(none)",
              (int)at<uint8_t>(g_base + A::GIsClient), (int)at<uint8_t>(g_base + A::GIsServer));
        if (g_state == 2 || g_state == 3) {
            logf_(
                "the world was replaced (the engine dropped the old net driver); listening again in 3 seconds");
            g_driver = 0;
            g_lastConns = 0;
            g_repTicks = 0;
            g_repMsTotal = 0;
        }
        g_state = 1;
    }
    if (g_state == 1 && GetTickCount64() - g_worldSeenAt > 3000)
        do_listen(world);
    if (g_state == 2 && g_driver) {
        bool registered = false;
        void *ctx = context_of(at<void *>(g_base + A::GEngine), world);
        if (ctx) {
            void **arr = at<void **>((uintptr_t)ctx + A::Context_ActiveNetDrivers);
            int32_t n = at<int32_t>((uintptr_t)ctx + A::Context_ActiveNetDrivers + 8);
            for (int i = 0; arr && i < n && i < 16; i++)
                if (arr[i * 2] == g_driver)
                    registered = true;
        }
        if (!registered) {
            logf_("the engine removed the net driver; listening again in 3 seconds");
            g_driver = 0;
            g_lastConns = 0;
            g_repTicks = 0;
            g_repMsTotal = 0;
            g_state = 1;
            g_worldSeenAt = GetTickCount64();
            return;
        }
        at<void *>((uintptr_t)g_driver + A::Driver_Notify) =
            (void *)((uintptr_t)world + A::World_NetworkNotify);
        at<void *>((uintptr_t)world + A::World_NetDriver) = g_driver;
        int32_t conns = at<int32_t>((uintptr_t)g_driver + A::Driver_ClientConnections + 8);
        if (conns != g_lastConns) {
            logf_("client connections: %d -> %d (tick %ld)", g_lastConns, conns, g_ticks);
            g_lastConns = conns;
            if (conns == 0) {
                g_repTicks = 0;
                g_repMsTotal = 0;
            }
        }
        player_watch(g_driver);
        if (g_replicate)
            replicate_tick(world, g_driver);
        if (g_stamina)
            stamina_tick(g_driver);
        progression_tick(world);
        materiali_live_tick(world);
        if (g_ticks % 3600 == 0)
            logf_("alive: tick %ld, %d client connection(s)", g_ticks, conns);
    }
}

// ---------------------------------------------------------------------------- stay out of sight
// A client build always creates its game window, even with -nullrhi. On a server copy that window
// would appear, take the keyboard focus from the game the player is using and block clicks until
// alt-tab. Every request to show or bring forward a window of this process is turned into "keep
// hidden".
static BOOL(WINAPI *orig_ShowWindow)(HWND, int) = 0;
static BOOL WINAPI hook_ShowWindow(HWND h, int) { return orig_ShowWindow(h, SW_HIDE); }
static BOOL(WINAPI *orig_SetForegroundWindow)(HWND) = 0;
static BOOL WINAPI hook_SetForegroundWindow(HWND) { return TRUE; }
static BOOL(WINAPI *orig_SetWindowPos)(HWND, HWND, int, int, int, int, UINT) = 0;
static BOOL WINAPI hook_SetWindowPos(HWND h, HWND after, int x, int y, int cx, int cy, UINT f) {
    f &= ~SWP_SHOWWINDOW;
    f |= SWP_NOACTIVATE;
    if (after == HWND_TOP || after == HWND_TOPMOST)
        f |= SWP_NOZORDER;
    return orig_SetWindowPos(h, after, x, y, cx, cy, f);
}
static HWND(WINAPI *orig_CreateWindowExW)(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int, HWND,
                                          HMENU, HINSTANCE, LPVOID) = 0;
static HWND WINAPI hook_CreateWindowExW(DWORD ex, LPCWSTR cls, LPCWSTR name, DWORD style, int x,
                                        int y, int w, int h, HWND parent, HMENU menu,
                                        HINSTANCE inst, LPVOID param) {
    if (!parent) {
        style &= ~WS_VISIBLE;
        ex |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        ex &= ~WS_EX_APPWINDOW;
    }
    return orig_CreateWindowExW(ex, cls, name, style, x, y, w, h, parent, menu, inst, param);
}
// Mouse and focus: the hidden window must never take the player's mouse. A game window confines the
// cursor to itself, captures the mouse, registers raw mouse input and re-centres the cursor; on an
// invisible server window that leaves the player's clicks going nowhere while the server starts. In
// server mode all of that is a no-op.
static BOOL(WINAPI *orig_ClipCursor)(const RECT *) = 0;
static BOOL WINAPI hook_ClipCursor(const RECT *) { return TRUE; }
static HWND(WINAPI *orig_SetCapture)(HWND) = 0;
static HWND WINAPI hook_SetCapture(HWND) { return 0; }
static BOOL(WINAPI *orig_RegisterRawInputDevices)(PCRAWINPUTDEVICE, UINT, UINT) = 0;
static BOOL WINAPI hook_RegisterRawInputDevices(PCRAWINPUTDEVICE, UINT, UINT) { return TRUE; }
static BOOL(WINAPI *orig_SetCursorPos)(int, int) = 0;
static BOOL WINAPI hook_SetCursorPos(int, int) { return TRUE; }
static HWND(WINAPI *orig_SetFocus)(HWND) = 0;
static HWND WINAPI hook_SetFocus(HWND) { return 0; }
static HWND(WINAPI *orig_SetActiveWindow)(HWND) = 0;
static HWND WINAPI hook_SetActiveWindow(HWND) { return 0; }

// Sound: Dauntless plays its sound through Wwise, which ignores -nosound. 2c-fix3 refused the
// Windows audio-device list outright and Wwise crashed (a refused list is something Windows never
// does). 2c-fix4 hands Wwise a working device list that is simply empty - "this PC has no
// speakers", a normal state on servers and virtual machines - so Wwise has no output device and
// stays silent. Deliberately not the per-app mute: Windows can remember that setting per program
// path, and the player's game is the same exe.
static const GUID kClsidMMDeviceEnumerator = {
    0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
static const GUID kIidUnknown = {
    0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
static const GUID kIidMMDeviceEnumerator = {
    0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
static const GUID kIidMMDeviceCollection = {
    0x0BD7A1BE, 0x7A1A, 0x44DB, {0x83, 0x97, 0xCC, 0x53, 0x92, 0x38, 0x7B, 0x5E}};
static const HRESULT kNotFound =
    (HRESULT)0x80070490; // HRESULT_FROM_WIN32(ERROR_NOT_FOUND): "no such device"
static volatile LONG g_audioFaked = 0;
static void audio_note(const char *what) {
    if (InterlockedIncrement(&g_audioFaked) <= 6)
        logf_("sound: %s (server copies stay silent)", what);
}

// Plain COM objects written out by hand (vtable order as in mmdeviceapi.h). Both are static and
// never freed.
struct EmptyCollection;
struct EmptyCollectionVtbl {
    HRESULT(STDMETHODCALLTYPE *QueryInterface)(EmptyCollection *, REFIID, void **);
    ULONG(STDMETHODCALLTYPE *AddRef)(EmptyCollection *);
    ULONG(STDMETHODCALLTYPE *Release)(EmptyCollection *);
    HRESULT(STDMETHODCALLTYPE *GetCount)(EmptyCollection *, UINT *);
    HRESULT(STDMETHODCALLTYPE *Item)(EmptyCollection *, UINT, void **);
};
struct EmptyCollection {
    const EmptyCollectionVtbl *v;
};
static HRESULT STDMETHODCALLTYPE ec_qi(EmptyCollection *self, REFIID iid, void **out) {
    if (!out)
        return E_POINTER;
    if (IsEqualGUID(iid, kIidUnknown) || IsEqualGUID(iid, kIidMMDeviceCollection)) {
        *out = self;
        return S_OK;
    }
    *out = 0;
    return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE ec_addref(EmptyCollection *) { return 1; }
static ULONG STDMETHODCALLTYPE ec_release(EmptyCollection *) { return 1; }
static HRESULT STDMETHODCALLTYPE ec_count(EmptyCollection *, UINT *n) {
    if (!n)
        return E_POINTER;
    *n = 0;
    return S_OK;
}
static HRESULT STDMETHODCALLTYPE ec_item(EmptyCollection *, UINT, void **d) {
    if (d)
        *d = 0;
    return E_INVALIDARG;
}
static const EmptyCollectionVtbl g_ecVtbl = {ec_qi, ec_addref, ec_release, ec_count, ec_item};
static EmptyCollection g_emptyCollection = {&g_ecVtbl};

struct EmptyEnumerator;
struct EmptyEnumeratorVtbl {
    HRESULT(STDMETHODCALLTYPE *QueryInterface)(EmptyEnumerator *, REFIID, void **);
    ULONG(STDMETHODCALLTYPE *AddRef)(EmptyEnumerator *);
    ULONG(STDMETHODCALLTYPE *Release)(EmptyEnumerator *);
    HRESULT(STDMETHODCALLTYPE *EnumAudioEndpoints)(EmptyEnumerator *, int, DWORD, void **);
    HRESULT(STDMETHODCALLTYPE *GetDefaultAudioEndpoint)(EmptyEnumerator *, int, int, void **);
    HRESULT(STDMETHODCALLTYPE *GetDevice)(EmptyEnumerator *, LPCWSTR, void **);
    HRESULT(STDMETHODCALLTYPE *RegisterEndpointNotificationCallback)(EmptyEnumerator *, void *);
    HRESULT(STDMETHODCALLTYPE *UnregisterEndpointNotificationCallback)(EmptyEnumerator *, void *);
};
struct EmptyEnumerator {
    const EmptyEnumeratorVtbl *v;
};
static HRESULT STDMETHODCALLTYPE ee_qi(EmptyEnumerator *self, REFIID iid, void **out) {
    if (!out)
        return E_POINTER;
    if (IsEqualGUID(iid, kIidUnknown) || IsEqualGUID(iid, kIidMMDeviceEnumerator)) {
        *out = self;
        return S_OK;
    }
    *out = 0;
    return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE ee_addref(EmptyEnumerator *) { return 1; }
static ULONG STDMETHODCALLTYPE ee_release(EmptyEnumerator *) { return 1; }
static HRESULT STDMETHODCALLTYPE ee_enum(EmptyEnumerator *, int, DWORD, void **out) {
    if (!out)
        return E_POINTER;
    audio_note("device list asked for: answered with no devices");
    *out = &g_emptyCollection;
    return S_OK;
}
static HRESULT STDMETHODCALLTYPE ee_default(EmptyEnumerator *, int, int, void **out) {
    if (out)
        *out = 0;
    audio_note("default speakers asked for: answered 'none'");
    return kNotFound;
}
static HRESULT STDMETHODCALLTYPE ee_get(EmptyEnumerator *, LPCWSTR, void **out) {
    if (out)
        *out = 0;
    return kNotFound;
}
static HRESULT STDMETHODCALLTYPE ee_reg(EmptyEnumerator *, void *) { return S_OK; }
static HRESULT STDMETHODCALLTYPE ee_unreg(EmptyEnumerator *, void *) { return S_OK; }
static const EmptyEnumeratorVtbl g_eeVtbl = {ee_qi,      ee_addref, ee_release, ee_enum,
                                             ee_default, ee_get,    ee_reg,     ee_unreg};
static EmptyEnumerator g_emptyEnumerator = {&g_eeVtbl};

static HRESULT(WINAPI *orig_CoCreateInstance)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID *) = 0;
static HRESULT WINAPI hook_CoCreateInstance(REFCLSID clsid, LPUNKNOWN outer, DWORD ctx, REFIID iid,
                                            LPVOID *out) {
    if (IsEqualGUID(clsid, kClsidMMDeviceEnumerator)) {
        if (!out)
            return E_POINTER;
        audio_note("audio device list created: an empty one");
        return ee_qi(&g_emptyEnumerator, iid, out);
    }
    return orig_CoCreateInstance(clsid, outer, ctx, iid, out);
}
static HRESULT(WINAPI *orig_CoCreateInstanceEx)(REFCLSID, IUnknown *, DWORD, COSERVERINFO *, DWORD,
                                                MULTI_QI *) = 0;
static HRESULT WINAPI hook_CoCreateInstanceEx(REFCLSID clsid, IUnknown *outer, DWORD ctx,
                                              COSERVERINFO *srv, DWORD n, MULTI_QI *r) {
    if (IsEqualGUID(clsid, kClsidMMDeviceEnumerator)) {
        audio_note("audio device list created: an empty one");
        HRESULT any = E_NOINTERFACE;
        DWORD got = 0;
        for (DWORD i = 0; r && i < n; i++) {
            r[i].hr = ee_qi(&g_emptyEnumerator, *r[i].pIID, (void **)&r[i].pItf);
            if (SUCCEEDED(r[i].hr)) {
                got++;
                any = S_OK;
            }
        }
        if (!r || n == 0)
            return E_INVALIDARG;
        return got == n ? S_OK : (got ? CO_S_NOTALLINTERFACES : any);
    }
    return orig_CoCreateInstanceEx(clsid, outer, ctx, srv, n, r);
}
static void keep_quiet_and_off_the_mouse(void) {
    HMODULE u = LoadLibraryA("user32.dll");
    HMODULE c = LoadLibraryA("combase.dll");
    struct {
        HMODULE m;
        const char *n;
        void *d;
        void **o;
    } hs[] = {
        {u, "ClipCursor", (void *)hook_ClipCursor, (void **)&orig_ClipCursor},
        {u, "SetCapture", (void *)hook_SetCapture, (void **)&orig_SetCapture},
        {u, "RegisterRawInputDevices", (void *)hook_RegisterRawInputDevices,
         (void **)&orig_RegisterRawInputDevices},
        {u, "SetCursorPos", (void *)hook_SetCursorPos, (void **)&orig_SetCursorPos},
        {u, "SetFocus", (void *)hook_SetFocus, (void **)&orig_SetFocus},
        {u, "SetActiveWindow", (void *)hook_SetActiveWindow, (void **)&orig_SetActiveWindow},
        {c, "CoCreateInstance", (void *)hook_CoCreateInstance, (void **)&orig_CoCreateInstance},
        {c, "CoCreateInstanceEx", (void *)hook_CoCreateInstanceEx,
         (void **)&orig_CoCreateInstanceEx}};
    int ok = 0, n = 0;
    for (auto &x : hs) {
        n++;
        void *f = x.m ? (void *)GetProcAddress(x.m, x.n) : 0;
        if (f && MH_CreateHook(f, x.d, x.o) == MH_OK && MH_EnableHook(f) == MH_OK)
            ok++;
        else
            logf_("mouse/sound: could not hook %s", x.n);
    }
    logf_("server copy kept off the mouse and silent (%d of %d functions)", ok, n);
}

static void hide_windows(void) {
    HMODULE u = LoadLibraryA("user32.dll");
    struct {
        const char *n;
        void *d;
        void **o;
    } hs[] = {{"ShowWindow", (void *)hook_ShowWindow, (void **)&orig_ShowWindow},
              {"SetForegroundWindow", (void *)hook_SetForegroundWindow,
               (void **)&orig_SetForegroundWindow},
              {"SetWindowPos", (void *)hook_SetWindowPos, (void **)&orig_SetWindowPos},
              {"CreateWindowExW", (void *)hook_CreateWindowExW, (void **)&orig_CreateWindowExW}};
    int ok = 0;
    for (auto &x : hs) {
        void *f = u ? (void *)GetProcAddress(u, x.n) : 0;
        if (f && MH_CreateHook(f, x.d, x.o) == MH_OK && MH_EnableHook(f) == MH_OK)
            ok++;
        else
            logf_("hide window: could not hook %s", x.n);
    }
    logf_("server window kept hidden and in the background (%d of 4 window functions)", ok);
}

// ---------------------------------------------------------------------------- server set-up
static void server_init(void) {
    // The work folder can be anywhere (any drive, spaces, non-English letters): wide-character path
    // for the log.
    wchar_t dir[MAX_PATH] = L".";
    char v[64];
    DWORD dn = GetEnvironmentVariableW(L"D1147_DIR", dir, MAX_PATH);
    if (dn == 0 || dn >= MAX_PATH) {
        dir[0] = L'.';
        dir[1] = 0;
    }
    if (GetEnvironmentVariableA("D1147_PORT", v, sizeof(v))) {
        int p = atoi(v);
        if (p > 0 && p < 65536)
            g_port = p;
    }
    wchar_t path[MAX_PATH + 64];
    swprintf(path, MAX_PATH + 64, L"%ls\\logs\\server_%d.log", dir, g_port);
    g_log = _wfopen(path, L"w");
    g_base = (uintptr_t)GetModuleHandleA(0);
    g_gameThread = GetCurrentThreadId();
    if (GetEnvironmentVariableA("D1147_REPLICATE", v, sizeof(v)) && v[0] == '0')
        g_replicate = false;
    if (GetEnvironmentVariableA("D1147_OWNER_ONLY", v, sizeof(v)) && v[0] == '0')
        g_ownerOnly = 0;
    if (GetEnvironmentVariableA("D1147_PROGRESSION", v, sizeof(v)) && v[0] == '0')
        g_progOk = false;
    if (GetEnvironmentVariableA("D1147_STAMINA", v, sizeof(v)) && v[0] == '0')
        g_stamina = false;
    logf_(
        "==== d1147 server loader, milestone 2c-fix5 (dxgi forwarding retries + compatibility-shim freeze fix, empty audio device list, off the mouse). exe base %p, port %d ====",
        (void *)g_base, g_port);

    // Only this exact build: the LoadMap call to the stripped Listen stub.
    static const uint8_t listenCall[5] = {0xE8, 0x0B, 0x79, 0x77, 0xFC};
    if (memcmp((void *)(g_base + A::LoadMapListenCall), listenCall, 5) != 0) {
        logf_("this is not the Dauntless 1.14.7 (CL 647472) exe; server mode not applied");
        return;
    }

    bool ok = true;
    {
        static const uint8_t r[5] = {0xB0, 0x01, 0x90, 0x90, 0x90};
        ok &= patch(A::LoadMapListenCall, listenCall, r, 5, "LoadMap listen -> true");
    }
    {
        static const uint8_t e[13] = {0x8B, 0x41, 0x78, 0xD1, 0xE8, 0x24, 0x01,
                                      0x88, 0x05, 0xBA, 0x9B, 0x42, 0x06};
        static const uint8_t r[13] = {0xC6, 0x05, 0xC0, 0x9B, 0x42, 0x06, 0x00,
                                      0x90, 0x90, 0x90, 0x90, 0x90, 0x90};
        ok &= patch(A::PreInitA_Client, e, r, 13, "PreInit A: GIsClient = 0");
    }
    {
        static const uint8_t e[12] = {0x0F, 0xB6, 0x41, 0x78, 0x24, 0x01,
                                      0x88, 0x05, 0xAF, 0x9B, 0x42, 0x06};
        static const uint8_t r[12] = {0xC6, 0x05, 0xB4, 0x9B, 0x42, 0x06,
                                      0x01, 0x90, 0x90, 0x90, 0x90, 0x90};
        ok &= patch(A::PreInitA_Server, e, r, 12, "PreInit A: GIsServer = 1");
    }
    {
        static const uint8_t e[1] = {0x01}, r[1] = {0x00};
        ok &= patch(A::PreInitB_ClientImm, e, r, 1, "PreInit B: GIsClient = 0");
    }
    {
        static const uint8_t e[1] = {0x00}, r[1] = {0x01};
        ok &= patch(A::PreInitC_ServerImm, e, r, 1, "PreInit C: GIsServer = 1");
    }
    {
        static const uint8_t e[7] = {0x44, 0x88, 0x25, 0xD4, 0x54, 0x42, 0x06},
                             r[7] = {0xC6, 0x05, 0xD4, 0x54, 0x42, 0x06, 0x00};
        ok &= patch(A::PreInitC_Client, e, r, 7, "PreInit C: GIsClient = 0");
    }
    at<uint8_t>(g_base + A::GIsServer) = 1;
    at<uint8_t>(g_base + A::GIsClient) = 0;

    AddVectoredExceptionHandler(1, on_exception);

    MH_STATUS s = MH_Initialize();
    logf_("MinHook init: %d", (int)s);
    hide_windows();
    keep_quiet_and_off_the_mouse();
    {
        static const uint8_t e[5] = {0x40, 0x53, 0x48, 0x81, 0xEC};
        ok &= hook(A::GetNetMode, e, 5, (void *)hook_GetNetMode, (void **)&orig_GetNetMode,
                   "UWorld net mode -> dedicated");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x08};
        ok &= hook(A::ActorGetNetMode, e, 5, (void *)hook_ActorGetNetMode,
                   (void **)&orig_ActorGetNetMode, "actor net mode -> dedicated");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x08};
        ok &= hook(A::ActorGetNetDriver, e, 5, (void *)hook_ActorGetNetDriver,
                   (void **)&orig_ActorGetNetDriver, "actor net driver fallback");
    }
    {
        static const uint8_t e[4] = {0x48, 0x8B, 0xC4, 0x48};
        ok &= hook(A::GameEngineTick, e, 4, (void *)hook_Tick, (void **)&orig_Tick, "engine tick");
    }
    {
        static const uint8_t e[4] = {0x40, 0x56, 0x41, 0x56};
        ok &= hook(A::SetReplicationDriver, e, 4, (void *)hook_SetReplicationDriver,
                   (void **)&orig_SetReplicationDriver, "no replication driver");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x08};
        ok &= hook(A::IsLevelInitForActor, e, 5, (void *)hook_IsLevelInitForActor,
                   (void **)&orig_IsLevelInitForActor, "level ready for every actor");
    }
    {
        static const uint8_t e[4] = {0x4C, 0x8B, 0xC1, 0x84};
        ok &= hook(A::IsNetReady, e, 4, (void *)hook_IsNetReady, (void **)&orig_IsNetReady,
                   "net-ready (no throttling)");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x08};
        ok &= hook(A::HasFinishedLoading, e, 5, (void *)hook_HasFinishedLoading,
                   (void **)&orig_HasFinishedLoading, "player finished loading");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x54, 0x24, 0x10};
        ok &= hook(A::SetupPlayerInput, e, 5, (void *)hook_SetupPlayerInput,
                   (void **)&orig_SetupPlayerInput, "skip input setup");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x08};
        ok &= hook(A::BountySeasonDates, e, 5, (void *)hook_BountySeasonDates,
                   (void **)&orig_BountySeasonDates, "bounty season dates");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x20};
        ok &= hook(A::SwitchGameWindow, e, 5, (void *)hook_SwitchGameWindow,
                   (void **)&orig_SwitchGameWindow, "no game-window view switch");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x10};
        ok &= hook(A::MessageDialogOpen, e, 5, (void *)hook_MessageDialogOpen,
                   (void **)&orig_MessageDialogOpen, "message boxes answered silently");
    }
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x18};
        ok &= hook(A::WeeklySeasonDates, e, 5, (void *)hook_WeeklySeasonDates,
                   (void **)&orig_WeeklySeasonDates, "weekly bounty season dates");
    }

    ok &= install_equipment_bridge();

    // the functions the replication loop calls must look as expected, or it stays off
    {
        struct {
            uintptr_t a;
            uint8_t b[4];
            const char *n;
        } chk[] = {{A::CallPreReplication, {0x48, 0x85, 0xD2, 0x0F}, "CallPreReplication"},
                   {A::SendClientAdjustment, {0x48, 0x89, 0x5C, 0x24}, "SendClientAdjustment"},
                   {A::CreateChannelByName, {0x40, 0x53, 0x55, 0x56}, "CreateChannelByName"},
                   {A::SetChannelActor, {0x48, 0x89, 0x5C, 0x24}, "SetChannelActor"},
                   {A::ReplicateActor, {0x4C, 0x8B, 0xDC, 0x55}, "ReplicateActor"},
                   {A::WeakPtrAssign, {0x40, 0x53, 0x48, 0x83}, "WeakPtrAssign"}};
        for (auto &c : chk)
            if (memcmp((void *)(g_base + c.a), c.b, 4) != 0) {
                logf_("replication OFF: %s is not where expected", c.n);
                g_replicate = false;
            }
    }
    logf_("replication loop: %s", g_replicate ? "on" : "OFF");
    logf_("owner-only actors go to their owner only: %s",
          g_ownerOnly ? "on" : "off (D1147_OWNER_ONLY=0)");
    {
        static const uint8_t e[5] = {0x48, 0x89, 0x5C, 0x24, 0x08};
        if (memcmp((void *)(g_base + A::QueryHuntPassSeason), e, 5) != 0) {
            logf_("progression request OFF: function not where expected");
            g_progOk = false;
        }
    }
    logf_("progression configuration request: %s", g_progOk ? "on" : "OFF");
    logf_(ok ? "server mode applied; waiting for the engine to start"
             : "server mode only PARTLY applied; see lines above");
    logf_("command line: %s", GetCommandLineA());
}

// ---------------------------------------------------------------------------- client mode: boss
// health bar (overlay) With D1147_CLIENT_BOSSBAR=1 the player's game shows the nearest behemoth's
// health and its parts' health in a small click-through window drawn over the top of the game
// window. The numbers come from the game's own replicated values:
// AArchonCreatureBase::GetCurrentHealth/GetMaxHealth/GetBehemothFullName and
// AMonsterPartActor::GetHealth/GetMaxHealth; a part's name is its MonsterPartComponent's object
// name (Head, LeftLeg, Tail...).
static bool g_clientBoss = false;
static long g_cTicks = 0;
struct BossPart {
    wchar_t name[48];
    float cur, max;
};
struct BossSnap {
    bool show;
    wchar_t name[64];
    float cur, max;
    int nparts;
    BossPart parts[12];
};
static BossSnap g_snap;
static CRITICAL_SECTION g_snapLock;
static volatile LONG g_snapSeq = 0;
static HWND g_gameWnd = 0;
struct ClsKind {
    void *cls;
    uint8_t kind;
}; // kind: 1 = behemoth, 2 = monster part, 3 = other
static ClsKind g_kinds[2048];
static void *g_kindsWorld = 0;
static bool class_chain_has(void *cls, const wchar_t *want) {
    for (int d = 0; cls && d < 40; d++, cls = at<void *>((uintptr_t)cls + A::Struct_Super))
        if (name_is(cls, want))
            return true;
    return false;
}
static uint8_t kind_of(void *cls) {
    uintptr_t h = ((uintptr_t)cls >> 4) & 2047;
    for (int i = 0; i < 2048; i++) {
        ClsKind &k = g_kinds[(h + i) & 2047];
        if (k.cls == cls)
            return k.kind;
        if (!k.cls) {
            k.cls = cls;
            k.kind = class_chain_has(cls, L"ArchonBehemoth")     ? 1
                     : class_chain_has(cls, L"MonsterPartActor") ? 2
                                                                 : 3;
            return k.kind;
        }
    }
    return 3;
}
static void *fn_cached(void *obj, const wchar_t *name, void **cache) {
    if (!*cache)
        *cache = find_function(at<void *>((uintptr_t)obj + A::Object_Class), name);
    return *cache;
}
struct PECall {
    void *obj;
    void *fn;
    uint8_t parms[32];
};
static void pe_call(void *arg) {
    PECall *c = (PECall *)arg;
    ((void (*)(void *, void *, void *))(g_base + A::ProcessEvent))(c->obj, c->fn, c->parms);
}
static bool call_float(void *obj, void *fn, float *out) {
    if (!fn)
        return false;
    PECall c;
    c.obj = obj;
    c.fn = fn;
    memset(c.parms, 0, sizeof(c.parms));
    if (!guarded(pe_call, &c))
        return false;
    *out = *(float *)c.parms;
    return true;
}
static void *g_fBehCur = 0, *g_fBehMax = 0, *g_fBehName = 0, *g_fPartCur = 0, *g_fPartMax = 0,
            *g_fLoc = 0;
static bool actor_loc(void *a, float *xyz) {
    if (!fn_cached(a, L"K2_GetActorLocation", &g_fLoc))
        return false;
    PECall c;
    c.obj = a;
    c.fn = g_fLoc;
    memset(c.parms, 0, sizeof(c.parms));
    if (!guarded(pe_call, &c))
        return false;
    memcpy(xyz, c.parms, 12);
    return true;
}
static void pretty_part(const wchar_t *in, wchar_t *out, int n) {
    // "LeftLeg" -> "Left leg", "head_part" -> "Head"; drops common suffixes
    wchar_t t[64];
    int k = 0;
    for (int i = 0; in[i] && k < 62; i++)
        t[k++] = in[i];
    t[k] = 0;
    const wchar_t *cut[] = {L"PartComponent", L"_part", L"Part", L"Component"};
    for (auto c : cut) {
        size_t lc = wcslen(c), lt = wcslen(t);
        if (lt > lc && _wcsicmp(t + lt - lc, c) == 0)
            t[lt - lc] = 0;
    }
    int o = 0;
    for (int i = 0; t[i] && o < n - 2; i++) {
        wchar_t ch = t[i];
        if (ch == L'_') {
            if (o && out[o - 1] != L' ')
                out[o++] = L' ';
            continue;
        }
        if (ch >= L'0' && ch <= L'9')
            continue;
        if (i && iswupper(ch) && o && out[o - 1] != L' ' && !iswupper(t[i - 1])) {
            out[o++] = L' ';
            ch = towlower(ch);
        } else if (o && out[o - 1] == L' ')
            ch = towlower(ch);
        out[o++] = ch;
    }
    while (o && out[o - 1] == L' ')
        o--;
    out[o] = 0;
    if (out[0])
        out[0] = towupper(out[0]);
    if (!out[0])
        wcsncpy(out, L"Part", n);
}
static void obj_wname(void *obj, wchar_t *out, int n) {
    FString s = {0, 0, 0};
    ((void (*)(void *, FString *))(g_base + A::AppendString))(
        (void *)((uintptr_t)obj + A::Object_Name), &s);
    int i = 0;
    for (; s.Data && i < n - 1 && i < s.Num && s.Data[i]; i++)
        out[i] = s.Data[i];
    out[i] = 0;
}
static void fname_w(uint64_t fname, wchar_t *out, int n) {
    FString s = {0, 0, 0};
    ((void (*)(void *, FString *))(g_base + A::AppendString))(&fname, &s);
    int i = 0;
    for (; s.Data && i < n - 1 && i < s.Num && s.Data[i]; i++)
        out[i] = s.Data[i];
    out[i] = 0;
}
static long g_bossNotes = 0;
static void boss_collect(void *world) {
    if (world != g_kindsWorld) {
        memset(g_kinds, 0, sizeof(g_kinds));
        g_kindsWorld = world;
    }
    void *gi = at<void *>((uintptr_t)world + A::World_GameInstance);
    TArrayRaw *lp = gi ? &at<TArrayRaw>((uintptr_t)gi + 0x38) : 0;
    void *pc = (lp && lp->Data && lp->Num > 0 && lp->Data[0])
                   ? at<void *>((uintptr_t)lp->Data[0] + 0x30)
                   : 0;
    void *pawn = pc ? at<void *>((uintptr_t)pc + A::PC_Pawn) : 0;
    float me[3] = {0, 0, 0};
    bool haveMe = pawn && actor_loc(pawn, me);
    void *beh[16];
    int nb = 0;
    void *parts[64];
    int np = 0;
    TArrayRaw &levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    for (int li = 0; levels.Data && li < levels.Num && li < 512; li++) {
        void *level = levels.Data[li];
        if (!level)
            continue;
        TArrayRaw &actors = at<TArrayRaw>((uintptr_t)level + A::Level_Actors);
        for (int ai = 0; actors.Data && ai < actors.Num; ai++) {
            void *a = actors.Data[ai];
            if (!a)
                continue;
            if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000)
                continue;
            uint8_t k = kind_of(at<void *>((uintptr_t)a + A::Object_Class));
            if (k == 1 && nb < 16)
                beh[nb++] = a;
            else if (k == 2 && np < 64)
                parts[np++] = a;
        }
    }
    BossSnap s;
    memset(&s, 0, sizeof(s));
    void *best = 0;
    float bestScore = 1e30f, bestCur = 0, bestMax = 0;
    for (int i = 0; i < nb; i++) {
        float cur = 0, mx = 0;
        if (!call_float(beh[i], fn_cached(beh[i], L"GetMaxHealth", &g_fBehMax), &mx) || mx <= 0)
            continue;
        call_float(beh[i], fn_cached(beh[i], L"GetCurrentHealth", &g_fBehCur), &cur);
        if (cur <= 0)
            continue;
        float d2 = 1e20f, p[3];
        if (haveMe && actor_loc(beh[i], p))
            d2 = (p[0] - me[0]) * (p[0] - me[0]) + (p[1] - me[1]) * (p[1] - me[1]) +
                 (p[2] - me[2]) * (p[2] - me[2]);
        bool hurt = cur < mx;
        if (!hurt && d2 > 9000.0f * 9000.0f)
            continue; // far away and untouched: not shown
        float score = d2 - (hurt ? 1e12f : 0);
        if (score < bestScore) {
            bestScore = score;
            best = beh[i];
            bestCur = cur;
            bestMax = mx;
        }
    }
    if (best) {
        s.show = true;
        s.cur = bestCur;
        s.max = bestMax;
        PECall c;
        c.obj = best;
        c.fn = fn_cached(best, L"GetBehemothFullName", &g_fBehName);
        memset(c.parms, 0, sizeof(c.parms));
        if (c.fn && guarded(pe_call, &c))
            fname_w(*(uint64_t *)c.parms, s.name, 64);
        // parts named by the behemoth's own MonsterPartComponents (each points at its replicated
        // part actor)
        static void *diagFor = 0;
        bool diag = best != diagFor;
        if (diag)
            diagFor = best;
        int ncomp = 0, nlinked = 0;
        for (int arr = 0; arr < 2; arr++) {
            TArrayRaw &cs = at<TArrayRaw>((uintptr_t)best +
                                          (arr ? A::Actor_BPComponents : A::Actor_InstComponents));
            for (int ci = 0; cs.Data && ci < cs.Num && ci < 256; ci++) {
                void *comp = cs.Data[ci];
                if (!comp)
                    continue;
                void *cc = at<void *>((uintptr_t)comp + A::Object_Class);
                static void *partCompClass = 0;
                if (cc != partCompClass) {
                    if (!class_chain_has(cc, L"MonsterPartComponent"))
                        continue;
                    partCompClass = cc;
                }
                ncomp++;
                void *pa = at<void *>((uintptr_t)comp + A::PartComp_Actor);
                if (diag) {
                    wchar_t cn[64];
                    obj_wname(comp, cn, 64);
                    char an[128];
                    logf_("boss bar:    component '%ls' -> part actor %s", cn,
                          pa ? name_of(pa, an, sizeof(an)) : "(none on this PC)");
                }
                if (!pa || s.nparts >= 12)
                    continue;
                nlinked++;
                bool dup = false;
                for (int k = 0; k < np; k++)
                    if (parts[k] == pa) {
                        dup = true;
                        break;
                    }
                if (!dup && np < 64)
                    parts[np++] = pa;
            }
        }
        if (diag)
            logf_("boss bar: %d part component(s) on this behemoth, %d with a part actor here",
                  ncomp, nlinked);
        for (int i = 0; i < np && s.nparts < 12; i++) {
            if (at<void *>((uintptr_t)parts[i] + A::Actor_Owner) != best) {
                bool mine =
                    false; // also accept part actors reached through the behemoth's components
                for (int arr = 0; arr < 2 && !mine; arr++) {
                    TArrayRaw &cs = at<TArrayRaw>(
                        (uintptr_t)best + (arr ? A::Actor_BPComponents : A::Actor_InstComponents));
                    for (int ci = 0; cs.Data && ci < cs.Num && ci < 256; ci++)
                        if (cs.Data[ci] &&
                            at<void *>((uintptr_t)cs.Data[ci] + A::PartComp_Actor) == parts[i]) {
                            mine = true;
                            break;
                        }
                }
                if (!mine)
                    continue;
            }
            float cur = 0, mx = 0;
            if (!call_float(parts[i], fn_cached(parts[i], L"GetMaxHealth", &g_fPartMax), &mx) ||
                mx <= 0)
                continue;
            call_float(parts[i], fn_cached(parts[i], L"GetHealth", &g_fPartCur), &cur);
            BossPart &bp = s.parts[s.nparts++];
            bp.cur = cur < 0 ? 0 : cur;
            bp.max = mx;
            void *comp = at<void *>((uintptr_t)parts[i] + A::Part_Component);
            wchar_t raw[64] = L"";
            if (comp)
                obj_wname(comp, raw, 64);
            pretty_part(raw, bp.name, 48);
        }
        static void *lastBest = 0;
        if (best != lastBest && ++g_bossNotes <= 40) {
            lastBest = best;
            char nm[160];
            logf_(
                "boss bar: showing %s '%ls' %.0f/%.0f with %d part(s) (of %d part actors in the world)",
                name_of(best, nm, sizeof(nm)), s.name, s.cur, s.max, s.nparts, np);
            for (int i = 0; i < s.nparts; i++)
                logf_("   part '%ls' %.0f/%.0f", s.parts[i].name, s.parts[i].cur, s.parts[i].max);
        }
    }
    EnterCriticalSection(&g_snapLock);
    g_snap = s;
    LeaveCriticalSection(&g_snapLock);
    InterlockedIncrement(&g_snapSeq);
}

// ---- the overlay window (own thread). Drawn into a 32-bit premultiplied-alpha bitmap; text via
// GDI as a coverage mask.
static BOOL CALLBACK find_game_wnd(HWND h, LPARAM) {
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid != GetCurrentProcessId() || !IsWindowVisible(h) || GetWindow(h, GW_OWNER))
        return TRUE;
    wchar_t cls[64];
    GetClassNameW(h, cls, 64);
    if (wcscmp(cls, L"UnrealWindow") == 0) {
        g_gameWnd = h;
        return FALSE;
    }
    return TRUE;
}
struct Canvas {
    uint32_t *px;
    int w, h;
};
static void blend(Canvas &c, int x, int y, uint32_t rgb, int a) { // a 0..255, rgb not premultiplied
    if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0)
        return;
    uint32_t &d = c.px[y * c.w + x];
    int da = d >> 24, dr = (d >> 16) & 255, dg = (d >> 8) & 255, db = d & 255;
    int sr = ((rgb >> 16) & 255) * a / 255, sg = ((rgb >> 8) & 255) * a / 255,
        sb = (rgb & 255) * a / 255;
    int ia = 255 - a;
    d = ((a + da * ia / 255) << 24) | ((sr + dr * ia / 255) << 16) | ((sg + dg * ia / 255) << 8) |
        (sb + db * ia / 255);
}
static void slant_bar(Canvas &c, int x, int y, int w, int h, int slant, uint32_t rgb, int a) {
    for (int j = 0; j < h; j++) {
        int off = slant * (h - 1 - j) / (h > 1 ? h - 1 : 1);
        for (int i = 0; i < w; i++)
            blend(c, x + off + i, y + j, rgb, a);
    }
}
static void bar_widget(Canvas &c, int x, int y, int w, int h, float frac, uint32_t fill,
                       uint32_t empty) {
    int sl = h / 3;
    slant_bar(c, x - 3, y - 3, w + 6, h + 6, sl, 0x3A3A3A, 235); // dark frame
    slant_bar(c, x, y, w, h, sl, empty, 235);
    if (frac > 0) {
        int fw = (int)(w * (frac > 1 ? 1 : frac) + 0.5f);
        if (fw > 0)
            slant_bar(c, x, y, fw, h, sl, fill, 245);
    }
}
static HDC g_tdc = 0;
static HBITMAP g_tbmp = 0;
static uint32_t *g_tpx = 0;
static int g_tw = 0, g_th = 0;
static void text(Canvas &c, int x, int y, const wchar_t *t, int size, bool bold) {
    if (!t || !t[0])
        return;
    int tw = c.w, th = size + 8;
    if (!g_tdc || g_tw != tw || g_th != th) {
        if (g_tbmp)
            DeleteObject(g_tbmp);
        if (!g_tdc)
            g_tdc = CreateCompatibleDC(0);
        BITMAPINFO bi = {};
        bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
        bi.bmiHeader.biWidth = tw;
        bi.bmiHeader.biHeight = -th;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        g_tbmp = CreateDIBSection(g_tdc, &bi, DIB_RGB_COLORS, (void **)&g_tpx, 0, 0);
        SelectObject(g_tdc, g_tbmp);
        g_tw = tw;
        g_th = th;
    }
    memset(g_tpx, 0, (size_t)tw * th * 4);
    HFONT f = CreateFontW(-size, 0, 0, 0, bold ? FW_BOLD : FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0,
                          0, ANTIALIASED_QUALITY, 0, L"Segoe UI");
    HGDIOBJ old = SelectObject(g_tdc, f);
    SetBkMode(g_tdc, TRANSPARENT);
    SetTextColor(g_tdc, RGB(255, 255, 255));
    TextOutW(g_tdc, 2, 2, t, (int)wcslen(t));
    GdiFlush();
    SelectObject(g_tdc, old);
    DeleteObject(f);
    for (int pass = 0; pass < 2; pass++) // 0: shadow, 1: white text
        for (int j = 0; j < th; j++)
            for (int i = 0; i < tw; i++) {
                int cov = g_tpx[j * tw + i] & 255;
                if (!cov)
                    continue;
                if (pass == 0) {
                    for (int dy = -1; dy <= 2; dy++)
                        for (int dx = -1; dx <= 2; dx++)
                            blend(c, x + i - 2 + dx, y + j - 2 + dy, 0x000000, cov * 2 / 3);
                } else
                    blend(c, x + i - 2, y + j - 2, 0xFFFFFF, cov);
            }
}
static void fmt_num(float v, wchar_t *out) {
    long long n = (long long)(v + 0.5f);
    if (n < 0)
        n = 0;
    wchar_t t[32];
    int k = 0;
    do {
        t[k++] = L'0' + (wchar_t)(n % 10);
        n /= 10;
        if (n && k % 4 == 3)
            t[k++] = L',';
    } while (n && k < 30);
    for (int i = 0; i < k; i++)
        out[i] = t[k - 1 - i];
    out[k] = 0;
}
// Where the bar sits: its centre at g_bbCx of the game window's width, its top at g_bbTy of the
// height. Ctrl+Alt+arrow keys move it (while it shows), Ctrl+Alt+Home puts it back; saved in
// <D1147_DIR>\data\bossbar_pos.txt.
static float g_bbCx = 0.5f, g_bbTy = 0.085f;
static wchar_t g_bbFile[MAX_PATH + 64] = L"";
static void bb_load() {
    if (!g_bbFile[0])
        return;
    FILE *f = _wfopen(g_bbFile, L"r");
    if (!f)
        return;
    float cx, ty;
    if (fscanf(f, "cx=%f ty=%f", &cx, &ty) == 2 && cx >= 0 && cx <= 1 && ty >= 0 && ty <= 0.95f) {
        g_bbCx = cx;
        g_bbTy = ty;
    }
    fclose(f);
}
static void bb_save() {
    if (!g_bbFile[0])
        return;
    FILE *f = _wfopen(g_bbFile, L"w");
    if (!f)
        return;
    fprintf(f, "cx=%.4f ty=%.4f\n", g_bbCx, g_bbTy);
    fclose(f);
}
static bool bb_keys() { // true when the bar moved this time
    static bool moving = false;
    bool ca = (GetAsyncKeyState(VK_CONTROL) & 0x8000) && (GetAsyncKeyState(VK_MENU) & 0x8000);
    float dx = 0, dy = 0;
    bool home = false;
    if (ca) {
        if (GetAsyncKeyState(VK_LEFT) & 0x8000)
            dx -= 0.01f;
        if (GetAsyncKeyState(VK_RIGHT) & 0x8000)
            dx += 0.01f;
        if (GetAsyncKeyState(VK_UP) & 0x8000)
            dy -= 0.01f;
        if (GetAsyncKeyState(VK_DOWN) & 0x8000)
            dy += 0.01f;
        home = (GetAsyncKeyState(VK_HOME) & 0x8000) != 0;
    }
    if (home) {
        g_bbCx = 0.5f;
        g_bbTy = 0.085f;
        moving = true;
        return true;
    }
    if (dx != 0 || dy != 0) {
        g_bbCx += dx;
        g_bbTy += dy;
        if (g_bbCx < 0)
            g_bbCx = 0;
        if (g_bbCx > 1)
            g_bbCx = 1;
        if (g_bbTy < 0)
            g_bbTy = 0;
        if (g_bbTy > 0.95f)
            g_bbTy = 0.95f;
        moving = true;
        return true;
    }
    if (moving) {
        moving = false;
        bb_save();
        logf_("boss bar: moved to cx=%.3f ty=%.3f (saved)", g_bbCx, g_bbTy);
    }
    return false;
}
static DWORD WINAPI overlay_thread(void *) {
    WNDCLASSW wc = {};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(0);
    wc.lpszClassName = L"d1147_bossbar";
    RegisterClassW(&wc);
    HWND ov = 0;
    int ow = 0, oh = 0;
    HDC mdc = CreateCompatibleDC(0);
    HBITMAP bmp = 0;
    uint32_t *px = 0;
    bool visible = false;
    LONG lastSeq = -1;
    RECT lastRc = {};
    for (;;) {
        MSG m;
        while (PeekMessageW(&m, 0, 0, 0, PM_REMOVE)) {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
        Sleep(100);
        if (!g_gameWnd || !IsWindow(g_gameWnd)) {
            g_gameWnd = 0;
            EnumWindows(find_game_wnd, 0);
            if (!g_gameWnd)
                continue;
        }
        BossSnap s;
        EnterCriticalSection(&g_snapLock);
        s = g_snap;
        LeaveCriticalSection(&g_snapLock);
        bool fg = GetForegroundWindow() == g_gameWnd && !IsIconic(g_gameWnd);
        if (!s.show || !fg) {
            if (visible && ov) {
                ShowWindow(ov, SW_HIDE);
                visible = false;
            }
            continue;
        }
        RECT rc;
        GetClientRect(g_gameWnd, &rc);
        POINT tl = {0, 0};
        ClientToScreen(g_gameWnd, &tl);
        int gw = rc.right - rc.left, gh = rc.bottom - rc.top;
        if (gw < 200 || gh < 200)
            continue;
        LONG seq = g_snapSeq;
        bool moved = bb_keys();
        if (!moved && seq == lastSeq && visible && tl.x == lastRc.left && tl.y == lastRc.top &&
            gw == lastRc.right && gh == lastRc.bottom)
            continue;
        lastSeq = seq;
        lastRc = {tl.x, tl.y, gw, gh};
        // layout (scaled to the game window): health bar ~31% of the width; the part bars packed
        // right under it, every row exactly as wide as the health bar (up to 4 per row, rows
        // balanced: 7 parts -> 4 + 3), name inside each bar
        float sc = gh / 1080.0f;
        if (sc < 0.6f)
            sc = 0.6f;
        int W = (int)(gw * 0.31f), bigH = (int)(30 * sc), partH = (int)(24 * sc),
            gapX = (int)(7 * sc), gapY = (int)(7 * sc), title = (int)(22 * sc);
        int n = s.nparts, rows = n ? (n + 3) / 4 : 0;
        int H = (int)(6 * sc) + title + bigH +
                (rows ? gapY + rows * partH + (rows - 1) * gapY : 0) + (int)(10 * sc);
        int Wtot = W + (int)(40 * sc);
        if (!ov) {
            ov =
                CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST |
                                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                wc.lpszClassName, L"", WS_POPUP, 0, 0, 1, 1, 0, 0, wc.hInstance, 0);
            logf_("boss bar: overlay window %s", ov ? "created" : "FAILED");
            if (!ov)
                return 0;
        }
        if (Wtot != ow || H != oh) {
            if (bmp)
                DeleteObject(bmp);
            BITMAPINFO bi = {};
            bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
            bi.bmiHeader.biWidth = Wtot;
            bi.bmiHeader.biHeight = -H;
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bmp = CreateDIBSection(mdc, &bi, DIB_RGB_COLORS, (void **)&px, 0, 0);
            SelectObject(mdc, bmp);
            ow = Wtot;
            oh = H;
        }
        memset(px, 0, (size_t)ow * oh * 4);
        Canvas c = {px, ow, oh};
        int x0 = (int)(20 * sc), y = (int)(6 * sc);
        wchar_t a[32], b[32], line[96];
        fmt_num(s.cur, a);
        fmt_num(s.max, b);
        if (s.name[0])
            text(c, x0 + 4, y, s.name, (int)(17 * sc), false);
        y += title;
        bar_widget(c, x0, y, W, bigH, s.max > 0 ? s.cur / s.max : 0, 0xB0403E, 0x4A1F1E);
        swprintf(line, 96, L"%ls/%ls", a, b);
        text(c, x0 + (int)(14 * sc), y + (bigH - (int)(22 * sc)) / 2 - 1, line, (int)(22 * sc),
             true);
        y += bigH + gapY;
        int idx = 0;
        for (int r = 0; r < rows; r++) {
            int inRow = n / rows + (r < n % rows ? 1 : 0); // balanced rows, the fuller ones first
            int pw = (W - (inRow - 1) * gapX) / inRow;
            int py = y + r * (partH + gapY);
            for (int col = 0; col < inRow && idx < n; col++, idx++) {
                int px0 = x0 + col * (pw + gapX);
                int wcol = (col == inRow - 1)
                               ? (x0 + W - px0)
                               : pw; // last bar ends exactly where the health bar ends
                bool broken = s.parts[idx].cur <= 0;
                bar_widget(c, px0, py, wcol, partH,
                           s.parts[idx].max > 0 ? s.parts[idx].cur / s.parts[idx].max : 0, 0xE8892B,
                           broken ? 0x5A5A5A : 0x4A3218);
                text(c, px0 + (int)(10 * sc), py + (partH - (int)(17 * sc)) / 2 - 1,
                     s.parts[idx].name, (int)(17 * sc), true);
            }
        }
        int dx0 = (int)(gw * g_bbCx) - Wtot / 2;
        if (dx0 < 0)
            dx0 = 0;
        if (dx0 > gw - Wtot)
            dx0 = gw - Wtot > 0 ? gw - Wtot : 0;
        int dy0 = (int)(gh * g_bbTy);
        if (dy0 > gh - H)
            dy0 = gh - H > 0 ? gh - H : 0;
        POINT dst = {tl.x + dx0, tl.y + dy0};
        SIZE sz = {ow, oh};
        POINT src = {0, 0};
        BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
        UpdateLayeredWindow(ov, 0, &dst, &sz, mdc, &src, 0, &bf, ULW_ALPHA);
        if (!visible) {
            ShowWindow(ov, SW_SHOWNOACTIVATE);
            SetWindowPos(ov, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            visible = true;
        }
    }
}

// Server side: how many part actors exist, and whether the replication loop can send them (logged
// when it changes).

// ---------------------------------------------------------------------------- client: Modded mode
// (Oct 19) Player's game only (servers never run these unless D1147_SERVER_MODS=1 loads UE4SS
// there):
//   - D1147_CLIENT_BOSSBAR=1 -> the boss health bar overlay above (log:
//   <D1147_DIR>\logs\client.log)
//   - "-dfmods" on the game's command line -> loads <exe folder>\ue4ss\UE4SS.dll (UE4SS without its
//   dwmapi.dll proxy)
static void (*orig_ClientTick)(void *, float, bool) = 0;
static void hook_ClientTick(void *engine, float dt, bool idle) {
    orig_ClientTick(engine, dt, idle);
    g_gameThread = GetCurrentThreadId();
    ++g_cTicks;
    void *world = at<void *>(g_base + A::GWorld);
    if (!world)
        return;
    materiali_live_tick(world, true);
    if (g_clientBoss && g_cTicks % 15 == 0)
        boss_collect(world);
}
static DWORD WINAPI ue4ss_thread(void *) {
    wchar_t p[MAX_PATH + 32];
    DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH);
    if (!n || n >= MAX_PATH) {
        dxgi_note("mods: exe path unknown, UE4SS not loaded");
        return 0;
    }
    wchar_t *sl = wcsrchr(p, L'\\');
    if (!sl)
        return 0;
    wcscpy(sl + 1, L"ue4ss\\UE4SS.dll");
    if (GetModuleHandleW(L"UE4SS.dll")) {
        dxgi_note("mods: UE4SS already loaded");
        return 0;
    }
    if (GetFileAttributesW(p) == INVALID_FILE_ATTRIBUTES) {
        dxgi_note("mods: ue4ss\\UE4SS.dll not found, UE4SS not loaded");
        return 0;
    }
    HMODULE m = LoadLibraryW(p);
    char msg[96];
    snprintf(msg, sizeof(msg), "mods: UE4SS %s (error %lu)", m ? "loaded" : "FAILED to load",
             m ? 0UL : GetLastError());
    dxgi_note(msg);
    logf_("%s", msg);
    return 0;
}
static bool has_arg(const wchar_t *want) {
    const wchar_t *c = GetCommandLineW();
    size_t wl = wcslen(want);
    for (const wchar_t *q = c; (q = wcsstr(q, want)) != nullptr; q += wl) {
        wchar_t before = q == c ? L' ' : q[-1], after = q[wl];
        if ((before == L' ' || before == L'\t') && (after == 0 || after == L' ' || after == L'\t'))
            return true;
    }
    return false;
}
// ---------------------------------------------------------------------------- client: corner badge
// (Oct 19) D1147_CLIENT_BADGE=<text> (up to 15 characters, e.g. "TR" for Trials Quick Retry): small
// white text with a shadow in the bottom-right corner of the game window while it is in front. Its
// own layered window, independent of the boss bar.
static wchar_t g_badge[16] = L"";
static DWORD WINAPI badge_thread(void *) {
    WNDCLASSW wc = {};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(0);
    wc.lpszClassName = L"d1147_badge";
    RegisterClassW(&wc);
    HWND ov = 0;
    HDC mdc = CreateCompatibleDC(0), tdc = CreateCompatibleDC(0);
    HBITMAP bmp = 0, tbmp = 0;
    uint32_t *px = 0;
    uint32_t *tpx = 0;
    int ow = 0, oh = 0;
    bool visible = false;
    RECT lastRc = {};
    for (;;) {
        MSG m;
        while (PeekMessageW(&m, 0, 0, 0, PM_REMOVE)) {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
        Sleep(250);
        if (!g_gameWnd || !IsWindow(g_gameWnd)) {
            g_gameWnd = 0;
            EnumWindows(find_game_wnd, 0);
            if (!g_gameWnd)
                continue;
        }
        bool fg = GetForegroundWindow() == g_gameWnd && !IsIconic(g_gameWnd);
        if (!fg) {
            if (visible && ov) {
                ShowWindow(ov, SW_HIDE);
                visible = false;
            }
            continue;
        }
        RECT rc;
        GetClientRect(g_gameWnd, &rc);
        POINT tl = {0, 0};
        ClientToScreen(g_gameWnd, &tl);
        int gw = rc.right - rc.left, gh = rc.bottom - rc.top;
        if (gw < 200 || gh < 200)
            continue;
        if (visible && tl.x == lastRc.left && tl.y == lastRc.top && gw == lastRc.right &&
            gh == lastRc.bottom)
            continue;
        lastRc = {tl.x, tl.y, gw, gh};
        float sc = gh / 1080.0f;
        if (sc < 0.6f)
            sc = 0.6f;
        int size = (int)(26 * sc), W = (int)(size * 0.75f * (int)wcslen(g_badge)) + size,
            H = size + 12;
        if (!ov) {
            ov =
                CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST |
                                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                wc.lpszClassName, L"", WS_POPUP, 0, 0, 1, 1, 0, 0, wc.hInstance, 0);
            if (!ov)
                return 0;
        }
        if (W != ow || H != oh) {
            if (bmp)
                DeleteObject(bmp);
            if (tbmp)
                DeleteObject(tbmp);
            BITMAPINFO bi = {};
            bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
            bi.bmiHeader.biWidth = W;
            bi.bmiHeader.biHeight = -H;
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bmp = CreateDIBSection(mdc, &bi, DIB_RGB_COLORS, (void **)&px, 0, 0);
            SelectObject(mdc, bmp);
            tbmp = CreateDIBSection(tdc, &bi, DIB_RGB_COLORS, (void **)&tpx, 0, 0);
            SelectObject(tdc, tbmp);
            ow = W;
            oh = H;
        }
        memset(px, 0, (size_t)W * H * 4);
        memset(tpx, 0, (size_t)W * H * 4);
        HFONT f = CreateFontW(-size, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0,
                              ANTIALIASED_QUALITY, 0, L"Segoe UI");
        HGDIOBJ old = SelectObject(tdc, f);
        SetBkMode(tdc, TRANSPARENT);
        SetTextColor(tdc, RGB(255, 255, 255));
        SIZE ts = {0, 0};
        GetTextExtentPoint32W(tdc, g_badge, (int)wcslen(g_badge), &ts);
        int tx = W - ts.cx - 4;
        if (tx < 2)
            tx = 2;
        TextOutW(tdc, tx, 4, g_badge, (int)wcslen(g_badge));
        GdiFlush();
        SelectObject(tdc, old);
        DeleteObject(f);
        Canvas c = {px, W, H};
        for (int pass = 0; pass < 2; pass++)
            for (int j = 0; j < H; j++)
                for (int i = 0; i < W; i++) {
                    int cov = tpx[j * W + i] & 255;
                    if (!cov)
                        continue;
                    if (pass == 0) {
                        for (int dy = -1; dy <= 2; dy++)
                            for (int dx = -1; dx <= 2; dx++)
                                blend(c, i + dx, j + dy, 0x000000, cov * 2 / 3);
                    } else
                        blend(c, i, j, 0xFFFFFF, cov);
                }
        int margin = (int)(14 * sc);
        POINT dst = {tl.x + gw - W - margin, tl.y + gh - H - margin};
        SIZE sz = {W, H};
        POINT src = {0, 0};
        BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
        UpdateLayeredWindow(ov, 0, &dst, &sz, mdc, &src, 0, &bf, ULW_ALPHA);
        if (!visible) {
            ShowWindow(ov, SW_SHOWNOACTIVATE);
            SetWindowPos(ov, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            visible = true;
        }
    }
}
static void client_mods_init() {
    char v[8];
    g_clientBoss = GetEnvironmentVariableA("D1147_CLIENT_BOSSBAR", v, sizeof(v)) && v[0] == '1';
    bool mods = has_arg(L"-dfmods");
    wchar_t liveRoot[MAX_PATH];
    const DWORD liveLength = GetEnvironmentVariableW(L"D1147_LIVE_DIR", liveRoot, MAX_PATH);
    const bool live = liveLength > 0 && liveLength < MAX_PATH;
    {
        wchar_t b[16];
        DWORD n = GetEnvironmentVariableW(L"D1147_CLIENT_BADGE", b, 16);
        if (n > 0 && n < 16) {
            wcscpy(g_badge, b);
            HANDLE t = CreateThread(0, 0, badge_thread, 0, 0, 0);
            if (t)
                CloseHandle(t);
        }
    }
    if (!g_clientBoss && !mods && !live)
        return;
    wchar_t dir[MAX_PATH] = L".";
    DWORD dn = GetEnvironmentVariableW(L"D1147_DIR", dir, MAX_PATH);
    if (dn == 0 || dn >= MAX_PATH) {
        dir[0] = L'.';
        dir[1] = 0;
    }
    wchar_t path[MAX_PATH + 64];
    swprintf(path, MAX_PATH + 64, L"%ls\\logs\\client.log", dir);
    g_log = _wfopen(path, L"w");
    swprintf(g_bbFile, MAX_PATH + 64, L"%ls\\data\\bossbar_pos.txt", dir);
    bb_load();
    g_base = (uintptr_t)GetModuleHandleA(0);
    g_gameThread = GetCurrentThreadId();
    logf_("==== d1147 loader, client: %s%s. exe base %p ====",
          g_clientBoss ? "boss health bar " : "", mods ? "UE4SS (-dfmods)" : "", (void *)g_base);
    if (mods) {
        HANDLE t = CreateThread(0, 0, ue4ss_thread, 0, 0, 0);
        if (t)
            CloseHandle(t);
    }
    if (!g_clientBoss && !live)
        return;
    static const uint8_t listenCall[5] = {0xE8, 0x0B, 0x79, 0x77, 0xFC};
    if (memcmp((void *)(g_base + A::LoadMapListenCall), listenCall, 5) != 0) {
        logf_("not the 1.14.7 exe; boss bar off");
        g_clientBoss = false;
        return;
    }
    AddVectoredExceptionHandler(1, on_exception);
    MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) {
        logf_("MinHook failed; boss bar off");
        g_clientBoss = false;
        return;
    }
    static const uint8_t e[4] = {0x48, 0x8B, 0xC4, 0x48};
    if (!hook(A::GameEngineTick, e, 4, (void *)hook_ClientTick, (void **)&orig_ClientTick,
              "engine tick (boss bar)")) {
        g_clientBoss = false;
        return;
    }
    if (!g_clientBoss)
        return;
    InitializeCriticalSection(&g_snapLock);
    memset(&g_snap, 0, sizeof(g_snap));
    HANDLE t = CreateThread(0, 0, overlay_thread, 0, 0, 0);
    if (t)
        CloseHandle(t);
}

// ---------------------------------------------------------------------------- client: significance
// guard (Oct 18) The game's Significance Manager (Unreal plugin) sometimes keeps a dead object in
// its list after a behemoth dies and fades. Its next update calls that object's GetWorld through
// freed memory and the game crashes (exe+0x1499436, every few kills).
// FManagedObjectInfo::UpdateSignificance (exe+0x14992A0, this = the entry, object at +0x10) now
// skips an entry whose object no longer looks like a live UObject: its vtable must point into the
// game exe. Player's game only.
namespace SG {
const uintptr_t UpdateSignificance = 0x14992A0;
}
static uintptr_t g_exeLo = 0, g_exeHi = 0;
static void *g_origUpdSig = nullptr;
static volatile LONG g_sigSkips = 0;
static bool readable(const void *p, size_t n) {
    MEMORY_BASIC_INFORMATION mi;
    if (!VirtualQuery(p, &mi, sizeof(mi)) || mi.State != MEM_COMMIT)
        return false;
    if (mi.Protect & (PAGE_NOACCESS | PAGE_GUARD))
        return false;
    if (!(mi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ |
                        PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)))
        return false;
    return (uintptr_t)p + n <= (uintptr_t)mi.BaseAddress + mi.RegionSize;
}
// Does this still look like a live UObject? vtable inside the exe, the vtable slot the caller is
// about to use (UpdateSignificance: +0x158) pointing into the exe too, and a readable class pointer
// (+0x10) whose own vtable is in the exe. Oct 19: a pt-BR player's crash passed the old vtable-only
// check and still called through a null slot. Oct 21 (FPS drop on hunts since the Oct 18/19
// guards): the checks used VirtualQuery, a system call, up to four times per object per tick on
// every significance-managed object (hundreds on a hunt, few in Ramsgate): CPU 90-100% and 30-45
// FPS on PCs that ran at 50%. The reads are now plain memory reads fenced by a vectored exception
// handler: a read of freed, unmapped memory lands on sg_try_read_land and counts as dead; nothing
// else changes.
extern "C" int sg_try_read(const void *p, uintptr_t *out);
extern "C" char sg_try_read_fault, sg_try_read_land;
__asm__(".text\n"
        ".globl sg_try_read\n"
        "sg_try_read:\n"
        ".globl sg_try_read_fault\n"
        "sg_try_read_fault:\n"
        "    movq (%rcx), %rax\n" // the one instruction allowed to fault
        "    movq %rax, (%rdx)\n"
        "    movl $1, %eax\n"
        "    ret\n"
        ".globl sg_try_read_land\n"
        "sg_try_read_land:\n"
        "    xorl %eax, %eax\n"
        "    ret\n");
static LONG CALLBACK sg_read_veh(EXCEPTION_POINTERS *ep) {
    if (ep->ExceptionRecord->ExceptionCode == 0xC0000005 &&
        ep->ExceptionRecord->ExceptionAddress == (void *)&sg_try_read_fault) {
        ep->ContextRecord->Rip = (DWORD64)(uintptr_t)&sg_try_read_land;
        return EXCEPTION_CONTINUE_EXECUTION;
    }
    return EXCEPTION_CONTINUE_SEARCH;
}
static inline bool sg_read(const void *p, uintptr_t *out) {
    return (uintptr_t)p >= 0x10000 && sg_try_read(p, out) != 0;
}
static const char *sg_dead(void *obj, size_t slot) {
    uintptr_t vt, fn, cls, cvt;
    if (!sg_read(obj, &vt))
        return "unreadable";
    if (vt < g_exeLo || vt >= g_exeHi)
        return "vtable outside the game";
    if (slot) {
        if (!sg_read((void *)(vt + slot), &fn))
            return "vtable slot unreadable";
        if (fn < g_exeLo || fn >= g_exeHi)
            return "vtable slot outside the game";
    }
    if (!sg_read((char *)obj + 0x10, &cls) || !cls || !sg_read((void *)cls, &cvt))
        return "class unreadable";
    if (cvt < g_exeLo || cvt >= g_exeHi)
        return "class vtable outside the game";
    return nullptr;
}
static void sg_log_skip(const char *site, void *obj, const char *why) {
    LONG n = InterlockedIncrement(&g_sigSkips);
    if (n <= 8) {
        char m[200];
        snprintf(m, sizeof(m), "significance guard: %s skipped a dead object (%p: %s), %ld so far",
                 site, obj, why, (long)n);
        dxgi_note(m);
    }
}
static void __fastcall upd_sig_hook(void *info, void *viewpoints, bool ascending) {
    uintptr_t o = 0;
    void *obj = info && sg_read((char *)info + 0x10, &o) ? (void *)o : nullptr;
    if (obj) {
        const char *why = sg_dead(obj, 0x158);
        if (why) {
            sg_log_skip("UpdateSignificance", obj, why);
            return;
        }
    }
    ((void(__fastcall *)(void *, void *, bool))g_origUpdSig)(info, viewpoints, ascending);
}
// Second site (Oct 19, nOsO's crash reports with the first guard on): the per-object
// PostSignificance thunk at exe+0x1D815E0 (rcx = holder, rdx = &entry; object at entry+0x10) casts
// the object and faults on its freed class pointer. The thunk returns void, so a dead object is
// simply skipped. The check runs in C; the hook itself is assembly so every argument register (rcx,
// rdx, r8, r9, xmm0-xmm3) reaches the game's code untouched.
namespace SG {
const uintptr_t PostSignificance = 0x1D815E0;
}
extern "C" void *g_origPostSig = nullptr;
extern "C" int sg_post_check(void *entryPtr) {
    uintptr_t e = 0, o = 0;
    void *entry = entryPtr && sg_read(entryPtr, &e) ? (void *)e : nullptr;
    void *obj = entry && sg_read((char *)entry + 0x10, &o) ? (void *)o : nullptr;
    if (!obj)
        return 0;
    const char *why = sg_dead(obj, 0);
    if (!why)
        return 0;
    sg_log_skip("PostSignificance", obj, why);
    return 1;
}
__attribute__((naked)) static void post_sig_hook() {
    __asm__ volatile(
        ".intel_syntax noprefix\n"
        "sub rsp, 0x88\n"
        "mov [rsp+0x20], rcx\n mov [rsp+0x28], rdx\n mov [rsp+0x30], r8\n mov [rsp+0x38], r9\n"
        "movdqu [rsp+0x40], xmm0\n movdqu [rsp+0x50], xmm1\n movdqu [rsp+0x60], xmm2\n movdqu [rsp+0x70], xmm3\n"
        "mov rcx, rdx\n"
        "call sg_post_check\n"
        "mov rcx, [rsp+0x20]\n mov rdx, [rsp+0x28]\n mov r8, [rsp+0x30]\n mov r9, [rsp+0x38]\n"
        "movdqu xmm0, [rsp+0x40]\n movdqu xmm1, [rsp+0x50]\n movdqu xmm2, [rsp+0x60]\n movdqu xmm3, [rsp+0x70]\n"
        "add rsp, 0x88\n"
        "test eax, eax\n"
        "jnz 1f\n"
        "jmp qword ptr [rip + g_origPostSig]\n"
        "1: ret\n"
        ".att_syntax prefix\n");
}
static void startup_messages_init(uintptr_t b);
static void client_init() {
    char v[8];
    HMODULE exe = GetModuleHandleW(nullptr);
    uintptr_t b = (uintptr_t)exe;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)b;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(b + dos->e_lfanew);
    if (nt->OptionalHeader.SizeOfImage < 0x6000000) {
        dxgi_note("significance guard: not the 1.14.7 game exe, off");
        return;
    }
    g_exeLo = b;
    g_exeHi = b + nt->OptionalHeader.SizeOfImage;
    client_mods_init();
    startup_messages_init(b);
    if (GetEnvironmentVariableA("D1147_SIGGUARD", v, sizeof(v)) && v[0] == '0') {
        dxgi_note("significance guard: off (D1147_SIGGUARD=0)");
        return;
    }
    static const uint8_t expect[12] = {0x48, 0x8B, 0xC4, 0x53, 0x48, 0x83,
                                       0xEC, 0x60, 0x83, 0x7A, 0x08, 0x00};
    if (memcmp((void *)(b + SG::UpdateSignificance), expect, sizeof(expect)) != 0) {
        dxgi_note("significance guard: game code differs, off");
        return;
    }
    AddVectoredExceptionHandler(1, sg_read_veh); // in front of any other handler: a fenced read
                                                 // never reaches the game's crash handling
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED)
        s = MH_CreateHook((void *)(b + SG::UpdateSignificance), (void *)upd_sig_hook,
                          &g_origUpdSig);
    if (s == MH_OK)
        s = MH_EnableHook((void *)(b + SG::UpdateSignificance));
    dxgi_note(s == MH_OK ? "significance guard: on" : "significance guard: hook FAILED, off");
    // second site
    static const uint8_t expect2[15] = {0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x74,
                                        0x24, 0x10, 0x57, 0x48, 0x83, 0xEC, 0x50};
    if (memcmp((void *)(b + SG::PostSignificance), expect2, sizeof(expect2)) != 0) {
        dxgi_note("significance guard 2: game code differs, off");
        return;
    }
    s = MH_CreateHook((void *)(b + SG::PostSignificance), (void *)post_sig_hook, &g_origPostSig);
    if (s == MH_OK)
        s = MH_EnableHook((void *)(b + SG::PostSignificance));
    dxgi_note(s == MH_OK ? "significance guard 2 (PostSignificance): on"
                         : "significance guard 2: hook FAILED, off");
}

// ---------------------------------------------------------------------------- client: startup
// messages (Oct 18) From KombatKing's Startup Messages R1 (AGPL-3.0-only), moved into this loader
// so no separate DLL is injected:
// - the offline "Failed to create IGameClient instance!" message is cleared (exact text only; the
// load result is kept)
// - the "press any key" start screen is skipped through the game's own ShouldSkipPressStartScreen
// check
#include "startup_message_policy.h"
namespace SM {
const uintptr_t LoadGameClient = 0x1477dd0, ShouldSkipPressStart = 0x17805a0;
}
static bool (*g_origLoadClient)(void *, void *) = nullptr;
static void (*g_origSkipPress)(void *, void *, void *) = nullptr;
static volatile LONG g_smErr = 0, g_smSkip = 0;
static bool sm_read(uintptr_t at, void *dest, size_t n) {
    if (!at || !readable((const void *)at, n))
        return false;
    memcpy(dest, (const void *)at, n);
    return true;
}
static bool load_client_hook(void *client, void *path) {
    const bool loaded = g_origLoadClient(client, path);
    if (StartupMessages::ClearExactError(loaded, client, sm_read) &&
        InterlockedIncrement(&g_smErr) <= 2)
        dxgi_note("startup messages: offline IGameClient message cleared");
    return loaded;
}
static void skip_press_hook(void *object, void *frame, void *result) {
    g_origSkipPress(object, frame, result); // keeps the Blueprint frame handling as it is
    if (result) {
        *(unsigned char *)result = 1;
        if (InterlockedIncrement(&g_smSkip) <= 2)
            dxgi_note("startup messages: press-start screen skipped");
    }
}
static void startup_messages_init(uintptr_t b) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_STARTUPFIX", v, sizeof(v)) && v[0] == '0') {
        dxgi_note("startup messages: off (D1147_STARTUPFIX=0)");
        return;
    }
    static const uint8_t load[8] = {0x48, 0x89, 0x5c, 0x24, 0x18, 0x55, 0x56, 0x57};
    static const uint8_t skip[6] = {0x40, 0x53, 0x48, 0x83, 0xec, 0x20};
    if (memcmp((void *)(b + SM::LoadGameClient), load, sizeof(load)) != 0 ||
        memcmp((void *)(b + SM::ShouldSkipPressStart), skip, sizeof(skip)) != 0) {
        dxgi_note("startup messages: game code differs, off");
        return;
    }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED)
        s = MH_CreateHook((void *)(b + SM::LoadGameClient), (void *)load_client_hook,
                          (void **)&g_origLoadClient);
    if (s == MH_OK)
        s = MH_CreateHook((void *)(b + SM::ShouldSkipPressStart), (void *)skip_press_hook,
                          (void **)&g_origSkipPress);
    if (s == MH_OK)
        s = MH_EnableHook((void *)(b + SM::LoadGameClient));
    if (s == MH_OK)
        s = MH_EnableHook((void *)(b + SM::ShouldSkipPressStart));
    if (s != MH_OK) {
        MH_DisableHook((void *)(b + SM::LoadGameClient));
        MH_DisableHook((void *)(b + SM::ShouldSkipPressStart));
    }
    dxgi_note(s == MH_OK ? "startup messages: on" : "startup messages: hook FAILED, off");
}

extern "C" BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        char v[8];
        if (GetEnvironmentVariableA("D1147_SERVER", v, sizeof(v)) && v[0] == '1') {
            server_init();
            // Modded mode "also on my servers": UE4SS in the server copies only when the scripts
            // ask for it
            if (GetEnvironmentVariableA("D1147_SERVER_MODS", v, sizeof(v)) && v[0] == '1') {
                HANDLE t = CreateThread(0, 0, ue4ss_thread, 0, 0, 0);
                if (t)
                    CloseHandle(t);
            }
        } else
            client_init();
    }
    return TRUE;
}
