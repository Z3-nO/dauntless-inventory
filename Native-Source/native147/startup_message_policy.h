#pragma once
// SPDX-License-Identifier: AGPL-3.0-only
#include <stdint.h>
#include <string.h>
namespace StartupMessages {
struct String {
    uintptr_t data;
    int32_t num, max;
};
static const wchar_t Error[] =
    L"Failed to create IGameClient instance!\nCheck that the game was run from the correct launcher.\nOnline Play may not be available.";
template <class Reader> bool ClearExactError(bool loaded, void *client, Reader read) {
    if (loaded || !client)
        return false;
    String value{};
    wchar_t text[sizeof(Error) / sizeof(wchar_t)]{};
    if (!read((uintptr_t)client + 0x68, &value, sizeof(value)) ||
        value.num != (int32_t)(sizeof(Error) / sizeof(wchar_t)) || value.max < value.num ||
        !read(value.data, text, sizeof(text)) || memcmp(text, Error, sizeof(text)) != 0)
        return false;
    *(int32_t *)((uintptr_t)client + 0x70) = 0;
    return true;
}
} // namespace StartupMessages
