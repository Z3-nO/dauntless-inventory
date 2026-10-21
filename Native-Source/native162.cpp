// SPDX-License-Identifier: AGPL-3.0-only
// Optional refresh extension. The original Forever server remains a separate DLL.
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "native147/minhook/MinHook.h"
#include "live_protocol.h"
static uintptr_t base;
static HMODULE originalModule;
static wchar_t root[MAX_PATH];
static bool server;
static void (*originalTick)(void *, float, bool);
struct Array {
    void **data;
    int num, cap;
};
template <class T> static T at(uintptr_t p) { return *(T *)p; }
static bool readable(uintptr_t p, size_t n) {
    MEMORY_BASIC_INFORMATION m{};
    return p >= 0x10000 && n < 0x100000 && p + n >= p && VirtualQuery((void *)p, &m, sizeof(m)) &&
           m.State == MEM_COMMIT && !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
           p + n <= (uintptr_t)m.BaseAddress + m.RegionSize;
}
static void *function(void *object, uintptr_t rva) {
    if (!readable((uintptr_t)object, 0x30))
        return nullptr;
    void *cls = at<void *>((uintptr_t)object + 0x10);
    for (int depth = 0; cls && depth < 20; ++depth) {
        if (!readable((uintptr_t)cls, 0x50))
            return nullptr;
        void *f = at<void *>((uintptr_t)cls + 0x48);
        for (int i = 0; f && i < 2048; ++i) {
            if (!readable((uintptr_t)f, 0xe0))
                return nullptr;
            if (at<uintptr_t>((uintptr_t)f + 0xd8) == base + rva &&
                at<unsigned char>((uintptr_t)f + 0xb4) == 0 &&
                at<unsigned short>((uintptr_t)f + 0xb6) == 0)
                return f;
            f = at<void *>((uintptr_t)f + 0x28);
        }
        cls = at<void *>((uintptr_t)cls + 0x40);
    }
    return nullptr;
}
static bool uuid(const char *s) {
    if (strlen(s) != 36)
        return false;
    for (int i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-')
                return false;
        } else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
            return false;
    }
    return true;
}
static bool fresh(const wchar_t *file) {
    FILETIME created, exit, kernel, user;
    WIN32_FILE_ATTRIBUTE_DATA info;
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exit, &kernel, &user) ||
        !GetFileAttributesExW(file, GetFileExInfoStandard, &info))
        return false;
    return CompareFileTime(&info.ftLastWriteTime, &created) > 0;
}
static bool (*originalInitialize)(void *, void *);
static void *pendingLoadout;
static ULONGLONG pendingUntil;
static int pendingSlot;
static char pendingOperation[37]{};
static bool initializeSlot(void *object, void *response) {
    if (object != pendingLoadout)
        return originalInitialize(object, response);
    pendingLoadout = nullptr;
    Array slots = at<Array>((uintptr_t)object + 0x600), rows = at<Array>((uintptr_t)response + 8);
    if (slots.num <= pendingSlot || slots.num > 128 || rows.num < 1 || rows.num > 128)
        return false;
    for (int i = 0; i < rows.num; ++i) {
        uintptr_t row = (uintptr_t)rows.data + i * 0x120;
        if (!readable(row, 0x120) || at<int>(row + 0x118) != pendingSlot)
            continue;
        void *slot = slots.data[pendingSlot];
        if (!readable((uintptr_t)slot, 0x300))
            return false;
        bool ok = ((bool (*)(void *, void *))(base + 0x15f1f70))(slot, (void *)row);
        if (ok) {
            if (server && at<int>((uintptr_t)object + 0x610) == pendingSlot)
                ((void (*)(void *, int, bool))(base + 0x1c01c40))(object, pendingSlot, true);
            ((void (*)(void *))(base + 0x15f9110))(object);
        }
        live_write_build_status(root, !server, pendingOperation, pendingSlot, ok);
        return ok;
    }
    return false;
}
static void loadoutTick(void *world) {
    static char completed[37]{};
    static bool hooked = false;
    wchar_t file[MAX_PATH];
    swprintf(file, MAX_PATH, L"%ls\\data\\materiali-live-loadout.txt", root);
    char operation[37]{};
    int slot = 0;
    if (!live_read_build(file, operation, &slot) || !uuid(operation) ||
        strcmp(operation, completed) == 0)
        return;
    if (!live_inventory_delivered(root, operation))
        return;
    if (pendingLoadout)
        return;
    Array levels = at<Array>((uintptr_t)world + 0x148);
    if (levels.num < 0 || levels.num > 128)
        return;
    void *loadout = nullptr;
    int matches = 0;
    for (int i = 0; levels.data && i < levels.num; ++i) {
        Array actors = at<Array>((uintptr_t)levels.data[i] + 0x98);
        if (actors.num < 0 || actors.num > 20000)
            return;
        for (int j = 0; actors.data && j < actors.num; ++j) {
            void *a = actors.data[j];
            if (function(a, 0x1c06e20) && readable((uintptr_t)a, 0x620) &&
                at<void *>((uintptr_t)a + 0x5c8)) {
                loadout = a;
                ++matches;
            }
        }
    }
    if (matches != 1)
        return;
    if (!hooked) {
        const unsigned char expected[] = {0x48, 0x89, 0x5c, 0x24, 0x10};
        if (memcmp((void *)(base + 0x15f1860), expected, 5) != 0)
            return;
        if (MH_CreateHook((void *)(base + 0x15f1860), (void *)initializeSlot,
                          (void **)&originalInitialize) != MH_OK)
            return;
        hooked = MH_EnableHook((void *)(base + 0x15f1860)) == MH_OK;
    }
    if (!hooked)
        return;
    Array slots = at<Array>((uintptr_t)loadout + 0x600);
    if (slot >= slots.num || slots.num > 128)
        return;
    pendingSlot = slot;
    memcpy(pendingOperation, operation, 37);
    live_write_build_status(root, !server, operation, slot, false);
    pendingLoadout = loadout;
    pendingUntil = GetTickCount64() + 15000;
    ((void (*)(void *))(base + 0x15f4de0))((void *)((uintptr_t)loadout + 0x228));
    memcpy(completed, operation, 37);
}
static void tick(void *engine, float dt, bool idle) {
    originalTick(engine, dt, idle);
    static ULONGLONG last = 0;
    static char completed[37]{};
    if (GetTickCount64() - last < 1500)
        return;
    last = GetTickCount64();
    void *world = at<void *>(base + 0x624a778);
    if (!readable((uintptr_t)world, 0x158))
        return;
    void *driver = at<void *>((uintptr_t)world + 0x38);
    if (!readable((uintptr_t)driver, 0xa0))
        return;
    Array connections = at<Array>((uintptr_t)driver + 0x90);
    int count = connections.num;
    wchar_t file[MAX_PATH];
    if (!server) {
        // A client server-connection is not in ClientConnections; require a fresh
        // single-player heartbeat from this same local package instead.
        swprintf(file, MAX_PATH, L"%ls\\data\\materiali-live-native.json", root);
        WIN32_FILE_ATTRIBUTE_DATA info{};
        FILETIME now{};
        if (!GetFileAttributesExW(file, GetFileExInfoStandard, &info))
            return;
        GetSystemTimePreciseAsFileTime(&now);
        ULARGE_INTEGER a{}, b{};
        a.LowPart = now.dwLowDateTime;
        a.HighPart = now.dwHighDateTime;
        b.LowPart = info.ftLastWriteTime.dwLowDateTime;
        b.HighPart = info.ftLastWriteTime.dwHighDateTime;
        if (a.QuadPart < b.QuadPart || a.QuadPart - b.QuadPart > 60000000ULL)
            return;
        char text[256]{};
        if (!live_read_status(file, text, sizeof(text)))
            return;
        if (!strstr(text, "\"connections\":1,"))
            return;
        count = 1;
    }
    // Idle dojo/hunt servers must never overwrite the connected server's status.
    if (server && count != 1)
        return;
    swprintf(file, MAX_PATH,
             server ? L"%ls\\data\\materiali-live-native.json"
                    : L"%ls\\data\\materiali-live-client.json",
             root);
    char status[256]{};
    snprintf(
        status, sizeof(status),
        "{\"protocol\":2,\"builds\":true,\"connections\":%d,\"pid\":%lu,\"lastInvoked\":\"%s\"}",
        count, GetCurrentProcessId(), completed);
    live_publish_status(file, status);
    if (count != 1)
        return;
    loadoutTick(world);
    swprintf(file, MAX_PATH, L"%ls\\data\\materiali-live-refresh.txt", root);
    if (!fresh(file))
        return;
    FILE *input = _wfopen(file, L"rb");
    char operation[38]{};
    if (!input)
        return;
    size_t n = fread(operation, 1, 37, input);
    fclose(input);
    if (n != 36 || !uuid(operation) || strcmp(operation, completed) == 0)
        return;
    Array levels = at<Array>((uintptr_t)world + 0x148);
    if (levels.num < 0 || levels.num > 128 || !readable((uintptr_t)levels.data, levels.num * 8))
        return;
    void *inventory = nullptr;
    void *refresh = nullptr;
    int matches = 0;
    for (int i = 0; i < levels.num; ++i) {
        if (!readable((uintptr_t)levels.data[i], 0xa8))
            return;
        Array actors = at<Array>((uintptr_t)levels.data[i] + 0x98);
        if (actors.num < 0 || actors.num > 20000 ||
            !readable((uintptr_t)actors.data, actors.num * 8))
            return;
        for (int j = 0; j < actors.num; ++j) {
            void *actor = actors.data[j];
            void *s = function(actor, 0x1bedcd0);
            if (!s)
                continue;
            void *c = function(actor, 0x1be83f0);
            if (!c)
                continue;
            inventory = actor;
            refresh = server ? s : c;
            ++matches;
        }
    }
    if (matches != 1)
        return;
    ((void (*)(void *, void *, void *))(base + 0x2119cc0))(inventory, refresh, nullptr);
    memcpy(completed, operation, 37);
}
static DWORD WINAPI initialize(void *) {
    for (int i = 0; i < 1800; ++i) {
        Sleep(100);
        if (at<void *>(base + 0x624a778))
            break;
        if (i == 1799)
            return 0;
    }
    auto target = (unsigned char *)(base + 0x34b8410);
    const unsigned char normal[] = {0x48, 0x8b, 0xc4};
    if (memcmp(target, normal, 3) != 0) {
        if (target[0] != 0xe9)
            return 0;
        uintptr_t relay = (uintptr_t)target + 5 + at<int>((uintptr_t)target + 1);
        if (!readable(relay, 14) || at<unsigned short>(relay) != 0x25ff)
            return 0;
        uintptr_t destination = at<uintptr_t>(relay + 6);
        MEMORY_BASIC_INFORMATION m{};
        if (!VirtualQuery((void *)destination, &m, sizeof(m)) || m.AllocationBase != originalModule)
            return 0;
    }
    const unsigned char processEvent[] = {0x40, 0x55, 0x56, 0x57};
    // The original server hooks ProcessEvent too; only the inventory UFunction
    // signatures are used for dispatch, leaving its existing routing intact.
    if (MH_Initialize() != MH_OK)
        return 0;
    if (MH_CreateHook(target, (void *)tick, (void **)&originalTick) != MH_OK)
        return 0;
    MH_EnableHook(target);
    return 0;
}
BOOL WINAPI DllMain(HMODULE self, DWORD reason, void *) {
    if (reason != DLL_PROCESS_ATTACH)
        return TRUE;
    DisableThreadLibraryCalls(self);
    wchar_t file[MAX_PATH];
    DWORD n = GetModuleFileNameW(self, file, MAX_PATH);
    if (!n || n >= MAX_PATH)
        return FALSE;
    wchar_t *slash = wcsrchr(file, L'\\');
    if (!slash)
        return FALSE;
    wcscpy(slash + 1, L"UndauntedInternalServer.base.dll");
    originalModule = LoadLibraryW(file);
    if (!originalModule)
        return FALSE;
    base = (uintptr_t)GetModuleHandleW(nullptr);
    server = wcsstr(GetCommandLineW(), L" -server") != nullptr;
    if (GetEnvironmentVariableW(L"MATERIALI_LIVE_DIR", root, MAX_PATH)) {
        HANDLE thread = CreateThread(nullptr, 0, initialize, nullptr, 0, nullptr);
        if (thread)
            CloseHandle(thread);
    }
    return TRUE;
}
