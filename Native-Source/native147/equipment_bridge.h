// SPDX-License-Identifier: AGPL-3.0-only
// Exact Dauntless 1.14.7 CL647472 only. Included after reflection helpers.
// The RPC wrappers retain validation, parameter decoding and event-data ownership.
// Replace only their empty InternalServerTryActivateAbility virtual target.
struct alignas(8) EquipmentPredictionKey {
    int16_t current;
    int16_t base;
    uint8_t stale;
    uint8_t serverInitiated;
    uint8_t padding[2];
    void *predictiveConnection;
};
static_assert(sizeof(EquipmentPredictionKey) == 16, "FPredictionKey layout");

static void equipment_activate(void *component, uint32_t handle, bool inputPressed,
                               EquipmentPredictionKey *prediction, void *eventData) {
    if (!component || !prediction)
        return;
    void *instance = nullptr;
    auto inputDown = (void (*)(void *, uint32_t))(g_base + 0x16DEC40);
    auto inputUp = (void (*)(void *, uint32_t))(g_base + 0x16DEC80);
    auto activate = (bool (*)(void *, uint32_t, EquipmentPredictionKey *, void **, void *, void *))(
        g_base + 0x16C85D0);
    // Preserve the key by value: the native RPC signature passes a local key.
    EquipmentPredictionKey key = *prediction;
    if (inputPressed)
        inputDown(component, handle);
    bool started = activate(component, handle, &key, &instance, nullptr, eventData);
    if (!started) {
        if (inputPressed)
            inputUp(component, handle);
        // Notify through ProcessEvent, so the existing Client RPC routing is kept.
        // Native execClientActivateAbilityFailed reads int32 handle, then int16 key.
        void *cls = at<void *>((uintptr_t)component + A::Object_Class);
        void *fn = find_function(cls, L"ClientActivateAbilityFailed");
        if (fn) {
            struct Failure {
                uint32_t handle;
                int16_t key;
                uint16_t padding;
            } args{handle, prediction->current, 0};
            ((void (*)(void *, void *, void *))(g_base + A::ProcessEvent))(component, fn, &args);
        } else {
            logf_("equipment: rejected ability %u, ClientActivateAbilityFailed unavailable",
                  handle);
        }
    }
    static unsigned reported = 0;
    if (reported++ < 64)
        logf_("equipment: activation handle=%u pressed=%d key=%d event=%d result=%s", handle,
              (int)inputPressed, (int)prediction->current, eventData != nullptr,
              started ? "started" : "rejected");
}

static bool install_equipment_bridge() {
    struct Check {
        uintptr_t rva;
        const char *bytes;
        size_t length;
    } checks[] = {
        {0x16C85D0, "\x4C\x89\x4C\x24\x20\x4C\x89\x44\x24\x18\x89\x54\x24\x10\x55\x53", 16},
        {0x16DEC40, "\x48\x8B\x81\xF8\x04\x00\x00\x4C", 8},
        {0x16DEC80, "\x48\x8B\x81\xF8\x04\x00\x00\x4C", 8}};
    for (const auto &c : checks) {
        if (memcmp((void *)(g_base + c.rva), c.bytes, c.length)) {
            logf_("equipment bridge OFF: native bytes differ at +0x%llX",
                  (unsigned long long)c.rva);
            return false;
        }
    }
    uintptr_t slots[] = {0x533D988 + 0x808, 0x53E2280 + 0x808};
    for (uintptr_t slot : slots) {
        if (at<uintptr_t>(g_base + slot) != g_base + 0x9EA380) {
            logf_("equipment bridge OFF: activation vtable target differs");
            return false;
        }
    }
    DWORD old[2]{};
    // Acquire both pages before writing either slot; avoid partially installed bridge.
    for (int i = 0; i < 2; ++i) {
        if (!VirtualProtect((void *)(g_base + slots[i]), sizeof(void *), PAGE_READWRITE, &old[i])) {
            for (int j = 0; j < i; ++j) {
                DWORD ignored;
                VirtualProtect((void *)(g_base + slots[j]), sizeof(void *), old[j], &ignored);
            }
            logf_("equipment bridge OFF: cannot protect activation vtable");
            return false;
        }
    }
    for (int i = 0; i < 2; ++i)
        InterlockedExchangePointer((void *volatile *)(g_base + slots[i]),
                                   (void *)&equipment_activate);
    for (int i = 0; i < 2; ++i) {
        DWORD ignored;
        VirtualProtect((void *)(g_base + slots[i]), sizeof(void *), old[i], &ignored);
    }
    logf_(
        "equipment bridge ON: base and Archon activation dispatch restored (server process only)");
    return true;
}
