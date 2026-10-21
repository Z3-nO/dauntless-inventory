// SPDX-License-Identifier: AGPL-3.0-only
// Optional local single-player refresh, called on the existing server game thread.
#include "../live_protocol.h"
struct MaterialiRefreshCall {
    void *object;
    void *function;
};
static void materiali_refresh_call(void *data) {
    auto *call = (MaterialiRefreshCall *)data;
    ((void (*)(void *, void *, void *))(g_base + A::ProcessEvent))(call->object, call->function,
                                                                   nullptr);
}
static bool materiali_uuid(const char *value) {
    if (strlen(value) != 36)
        return false;
    for (int i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != '-')
                return false;
        } else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f')))
            return false;
    }
    return true;
}

// Experimental callback: update an existing slot rather than replacing the
// entire array of replicated UObjects, whose references are held by the UI.
static bool (*materiali_original_initialize)(void *, void *) = nullptr;
static void *materiali_pending_loadout = nullptr;
static ULONGLONG materiali_pending_until = 0;
static int materiali_pending_slot = 0;
static bool materiali_pending_client = false;
static char materiali_pending_operation[37]{};
static wchar_t materiali_pending_root[MAX_PATH]{};
static bool materiali_initialize_slot(void *object, void *response) {
    if (object != materiali_pending_loadout)
        return materiali_original_initialize(object, response);
    materiali_pending_loadout = nullptr;
    auto slots = at<TArrayRaw>((uintptr_t)object + 0x670);
    auto rows = at<TArrayRaw>((uintptr_t)response + 8);
    if (slots.Num <= materiali_pending_slot || slots.Num > 128 || rows.Num < 1 || rows.Num > 128)
        return false;
    for (int i = 0; i < rows.Num; ++i) {
        uintptr_t row = (uintptr_t)rows.Data + (uintptr_t)i * 0x180;
        if (!readable(row, 0x180) || at<int>(row + 0x178) != materiali_pending_slot)
            continue;
        void *slot = slots.Data[materiali_pending_slot];
        if (!slot || !readable((uintptr_t)slot, 0x3c0))
            return false;
        bool ok = ((bool (*)(void *, void *))(g_base + 0x1BE8490))(slot, (void *)row);
        if (ok) {
            // Force the existing active-slot RPC to apply changed gear even when
            // its slot number has not changed. Other slots stay inactive.
            if (!materiali_pending_client &&
                at<int>((uintptr_t)object + 0x680) == materiali_pending_slot)
                ((void (*)(void *, int, bool))(g_base + 0x22DB430))(object, materiali_pending_slot,
                                                                    true);
            ((void (*)(void *))(g_base + 0x1BAE000))(object);
        }
        live_write_build_status(materiali_pending_root, materiali_pending_client,
                                materiali_pending_operation, materiali_pending_slot, ok);
        dxgi_note(ok ? "materiali live: existing slot updated"
                     : "materiali live: existing slot rejected");
        return ok;
    }
    return false;
}
static bool materiali_initialize_hook() {
    static bool ready = false;
    if (ready)
        return true;
    const unsigned char expect[] = {0x48, 0x89, 0x5C, 0x24, 0x08};
    if (memcmp((void *)(g_base + 0x1BA6810), expect, sizeof(expect)) != 0)
        return false;
    if (MH_CreateHook((void *)(g_base + 0x1BA6810), (void *)materiali_initialize_slot,
                      (void **)&materiali_original_initialize) != MH_OK)
        return false;
    ready = MH_EnableHook((void *)(g_base + 0x1BA6810)) == MH_OK;
    return ready;
}
static void materiali_loadout_query(void *data) {
    materiali_pending_loadout = data;
    materiali_pending_until = GetTickCount64() + 15000;
    ((void (*)(void *))(g_base + 0x1BA9860))((void *)((uintptr_t)data + 0x228));
}
static void materiali_loadout_tick(void *world, const wchar_t *root, bool client) {
    static char completed[37]{};
    wchar_t file[MAX_PATH]{};
    swprintf(file, MAX_PATH, L"%ls\\data\\materiali-live-loadout.txt", root);
    char operation[37]{};
    int slot = 0;
    if (!live_read_build(file, operation, &slot) || !materiali_uuid(operation) ||
        strcmp(operation, completed) == 0)
        return;
    if (!live_inventory_delivered(root, operation))
        return;
    if (materiali_pending_loadout)
        return;
    // RequestOnlineData is the native loadout service request used at login.
    const unsigned char expect[] = {0x48, 0x89, 0x5C, 0x24, 0x20, 0x57, 0x48, 0x83, 0xEC, 0x40};
    if (memcmp((void *)(g_base + 0x1BA9860), expect, sizeof(expect)) != 0)
        return;
    void *loadout = nullptr;
    int matches = 0;
    auto levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    if (levels.Num < 0 || levels.Num > 64)
        return;
    for (int i = 0; levels.Data && i < levels.Num; ++i) {
        auto actors = at<TArrayRaw>((uintptr_t)levels.Data[i] + A::Level_Actors);
        if (actors.Num < 0 || actors.Num > 20000)
            return;
        for (int j = 0; actors.Data && j < actors.Num; ++j) {
            void *actor = actors.Data[j];
            if (!actor || !readable((uintptr_t)actor, 0x640))
                continue;
            auto fn = find_function(at<void *>((uintptr_t)actor + A::Object_Class),
                                    L"ServerCommitLoadout");
            if (!fn || !readable((uintptr_t)fn, 0xE0) ||
                at<uintptr_t>((uintptr_t)fn + 0xD8) != g_base + 0x22E0C20)
                continue;
            if (!at<void *>((uintptr_t)actor + 0x638))
                continue;
            loadout = actor;
            ++matches;
        }
    }
    if (matches != 1 || !materiali_initialize_hook())
        return;
    auto slots = at<TArrayRaw>((uintptr_t)loadout + 0x670);
    if (slot >= slots.Num || slots.Num > 128)
        return;
    materiali_pending_slot = slot;
    materiali_pending_client = client;
    memcpy(materiali_pending_operation, operation, 37);
    wcscpy(materiali_pending_root, root);
    live_write_build_status(root, client, operation, slot, false);
    if (!guarded(materiali_loadout_query, loadout))
        return;
    memcpy(completed, operation, 37);
    if (client)
        dxgi_note("materiali live: native loadout query requested");
    else
        logf_("materiali live: native loadout query requested");
}
static void materiali_live_tick(void *world, bool client = false) {
    static ULONGLONG lastCheck = 0;
    static char completed[37]{};
    ULONGLONG now = GetTickCount64();
    if (now - lastCheck < 1500)
        return;
    lastCheck = now;
    wchar_t root[MAX_PATH]{};
    DWORD length =
        GetEnvironmentVariableW(client ? L"D1147_LIVE_DIR" : L"D1147_DIR", root, MAX_PATH);
    if (!length || length >= MAX_PATH - 64)
        return;
    wchar_t signal[MAX_PATH]{}, status[MAX_PATH]{};
    swprintf(signal, MAX_PATH, L"%ls\\data\\materiali-live-refresh.txt", root);
    swprintf(status, MAX_PATH,
             client ? L"%ls\\data\\materiali-live-client.json"
                    : L"%ls\\data\\materiali-live-native.json",
             root);
    TArrayRaw conns{};
    if (!client)
        conns = at<TArrayRaw>((uintptr_t)g_driver + A::Driver_ClientConnections);
    else {
        wchar_t serverStatus[MAX_PATH]{};
        swprintf(serverStatus, MAX_PATH, L"%ls\\data\\materiali-live-native.json", root);
        WIN32_FILE_ATTRIBUTE_DATA info{};
        FILETIME time{};
        if (!GetFileAttributesExW(serverStatus, GetFileExInfoStandard, &info))
            return;
        GetSystemTimePreciseAsFileTime(&time);
        ULARGE_INTEGER a{}, b{};
        a.LowPart = time.dwLowDateTime;
        a.HighPart = time.dwHighDateTime;
        b.LowPart = info.ftLastWriteTime.dwLowDateTime;
        b.HighPart = info.ftLastWriteTime.dwHighDateTime;
        if (a.QuadPart < b.QuadPart || a.QuadPart - b.QuadPart > 60000000ULL)
            return;
        char data[256]{};
        if (!live_read_status(serverStatus, data, sizeof(data)))
            return;
        if (!strstr(data, "\"connections\":1,"))
            return;
        conns.Num = 1;
    }
    char heartbeat[256]{};
    snprintf(
        heartbeat, sizeof(heartbeat),
        "{\"protocol\":2,\"builds\":true,\"pid\":%lu,\"connections\":%d,\"lastInvoked\":\"%s\"}",
        GetCurrentProcessId(), conns.Num, completed);
    live_publish_status(status, heartbeat);
    if (conns.Num != 1)
        return; // Never refresh another player's inventory on a multiplayer server.
    materiali_loadout_tick(world, root, client);
    if (!live_command_is_current(signal))
        return;
    char operation[38]{};
    FILE *input = _wfopen(signal, L"rb");
    if (!input)
        return;
    size_t count = fread(operation, 1, 37, input);
    fclose(input);
    if (count != 36 || !materiali_uuid(operation) || strcmp(operation, completed) == 0)
        return;
    // Exactly one native inventory actor is required; reject ambiguous worlds.
    void *inventory = nullptr;
    void *refresh = nullptr;
    void *notify = nullptr;
    int matches = 0;
    auto levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    if (levels.Num < 0 || levels.Num > 64)
        return;
    for (int i = 0; levels.Data && i < levels.Num; ++i) {
        auto actors = at<TArrayRaw>((uintptr_t)levels.Data[i] + A::Level_Actors);
        if (actors.Num < 0 || actors.Num > 20000)
            return;
        for (int j = 0; actors.Data && j < actors.Num; ++j) {
            void *actor = actors.Data[j];
            if (!actor || !readable((uintptr_t)actor, 0x30))
                continue;
            void *cls = at<void *>((uintptr_t)actor + A::Object_Class);
            void *fn = find_function(cls, L"ServerRefreshInventory");
            void *client = find_function(cls, L"ClientRefreshInventory");
            if (!fn || !client || !readable((uintptr_t)fn, 0xE0) ||
                !readable((uintptr_t)client, 0xE0))
                continue;
            if (at<uint8_t>((uintptr_t)fn + 0xB4) != 0 || at<uint16_t>((uintptr_t)fn + 0xB6) != 0 ||
                at<uint8_t>((uintptr_t)client + 0xB4) != 0 ||
                at<uint16_t>((uintptr_t)client + 0xB6) != 0)
                continue;
            // Reflection signatures must match the inspected CL647472 inventory functions.
            if (at<uintptr_t>((uintptr_t)fn + 0xD8) != g_base + 0x22C6AA0 ||
                at<uintptr_t>((uintptr_t)client + 0xD8) != g_base + 0x22C1230)
                continue;
            inventory = actor;
            refresh = fn;
            notify = client;
            ++matches;
        }
    }
    if (matches != 1)
        return;
    MaterialiRefreshCall call{inventory, client ? notify : refresh};
    if (!guarded(materiali_refresh_call, &call)) {
        logf_("materiali live: guarded refresh failed; no acknowledgement");
        return;
    }
    memcpy(completed, operation, 37);
    if (client)
        dxgi_note("materiali live: local client inventory refresh invoked");
    else
        logf_("materiali live: native inventory refresh invoked (%s)", completed);
}
