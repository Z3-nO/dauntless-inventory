// SPDX-License-Identifier: AGPL-3.0-only
#pragma once
#include <windows.h>
#include <stdio.h>
#include <string.h>

// Publish complete status snapshots. Readers must never see a truncated JSON
// file while the client and server exchange their acknowledgements.
static bool live_publish_status(const wchar_t *file, const char *text) {
    wchar_t temporary[MAX_PATH]{};
    int length = swprintf(temporary, MAX_PATH, L"%ls.%lu.tmp", file, GetCurrentProcessId());
    if (length < 0 || length >= MAX_PATH)
        return false;
    HANDLE output = CreateFileW(temporary, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (output == INVALID_HANDLE_VALUE)
        return false;
    DWORD written = 0;
    DWORD size = (DWORD)strlen(text);
    bool complete = WriteFile(output, text, size, &written, nullptr) && written == size;
    if (!CloseHandle(output))
        complete = false;
    if (complete) {
        complete = false;
        // Some Windows readers briefly deny replacement. Leave the previous
        // complete status intact and bound retries to a few milliseconds.
        for (int attempt = 0; attempt < 12; ++attempt) {
            if (MoveFileExW(temporary, file, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
                complete = true;
                break;
            }
            DWORD error = GetLastError();
            if (error != ERROR_ACCESS_DENIED && error != ERROR_SHARING_VIOLATION &&
                error != ERROR_LOCK_VIOLATION)
                break;
            if (attempt < 11)
                Sleep(1);
        }
    }
    if (!complete) {
        DWORD error = GetLastError();
        DeleteFileW(temporary);
        SetLastError(error);
    }
    return complete;
}

static bool live_read_status(const wchar_t *file, char *text, DWORD capacity) {
    if (capacity < 2)
        return false;
    HANDLE input =
        CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (input == INVALID_HANDLE_VALUE)
        return false;
    DWORD size = 0;
    bool complete = ReadFile(input, text, capacity - 1, &size, nullptr) != 0;
    CloseHandle(input);
    text[size] = '\0';
    return complete && size > 0;
}

// Commands from an earlier process are already represented by the normal login
// response. Replaying them would issue an unnecessary second initialization.
static bool live_command_is_current(const wchar_t *file) {
    FILETIME created, exited, kernel, user;
    WIN32_FILE_ATTRIBUTE_DATA info;
    return GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) &&
           GetFileAttributesExW(file, GetFileExInfoStandard, &info) &&
           CompareFileTime(&info.ftLastWriteTime, &created) > 0;
}

static bool live_read_build(const wchar_t *file, char *operation, int *slot) {
    if (!live_command_is_current(file))
        return false;
    FILE *input = _wfopen(file, L"rb");
    if (!input)
        return false;
    char command[64]{};
    size_t size = fread(command, 1, sizeof(command), input);
    fclose(input);
    // UUID, newline, zero-based slot, newline. Reject trailing or oversized data.
    if (size < 39 || size >= sizeof(command) || command[36] != '\n' || command[size - 1] != '\n')
        return false;
    command[36] = 0;
    if (strlen(command) != 36)
        return false;
    int value = 0;
    for (size_t i = 37; i < size - 1; ++i) {
        if (command[i] < '0' || command[i] > '9')
            return false;
        value = value * 10 + command[i] - '0';
        if (value >= 128)
            return false;
    }
    memcpy(operation, command, 37);
    *slot = value;
    return true;
}

static void live_write_build_status(const wchar_t *root, bool client, const char *operation,
                                    int slot, bool applied) {
    wchar_t file[MAX_PATH]{};
    swprintf(file, MAX_PATH,
             client ? L"%ls\\data\\materiali-live-loadout-client.json"
                    : L"%ls\\data\\materiali-live-loadout-server.json",
             root);
    char status[256]{};
    snprintf(status, sizeof(status),
             "{\"protocol\":2,\"pid\":%lu,\"id\":\"%s\",\"slot\":%d,\"applied\":%s}",
             GetCurrentProcessId(), operation, slot, applied ? "true" : "false");
    live_publish_status(file, status);
}

static bool live_inventory_delivered(const wchar_t *root, const char *operation) {
    // Both processes must have requested their inventory before a slot resolves
    // its item IDs. Backend receipt status alone is not a client acknowledgement.
    for (int client = 0; client < 2; ++client) {
        wchar_t file[MAX_PATH]{};
        swprintf(file, MAX_PATH,
                 client ? L"%ls\\data\\materiali-live-client.json"
                        : L"%ls\\data\\materiali-live-native.json",
                 root);
        char status[384]{};
        if (!live_read_status(file, status, sizeof(status)))
            return false;
        if (!strstr(status, operation))
            return false;
    }
    return true;
}
