// Sample firmware-like C code used to build the corpus. Deliberately covers:
// string handling, tables, pointer arithmetic, crypto-ish bit math, syscall
// wrappers, struct access, and a deliberately patched pair for diffing.

#include "freestanding/stdint.h"

#define VERSION_MAGIC 0x46573100u

typedef struct {
    uint32_t magic;
    uint16_t hdr_len;
    uint8_t  flags;
    uint8_t  version;
    uint32_t payload_crc;
    char     name[16];
} fw_hdr_t;

static const uint32_t crc_table[8] = {
    0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac,
    0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c
};

uint32_t fw_crc32_update(uint32_t crc, const uint8_t *buf, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        crc ^= buf[i];
        crc = (crc >> 4) ^ crc_table[crc & 0x7];
        crc = (crc >> 4) ^ crc_table[crc & 0x7];
    }
    return crc;
}

int fw_validate(const fw_hdr_t *hdr, const uint8_t *blob, size_t blob_len)
{
    if (hdr == NULL || blob == NULL) {
        return -1;
    }
    if (hdr->magic != VERSION_MAGIC) {
        return -2;
    }
    if (hdr->hdr_len < sizeof(fw_hdr_t)) {
        return -3;
    }
    if (blob_len < hdr->hdr_len) {
        return -4;
    }
    uint32_t calc = fw_crc32_update(0xffffffffu, blob + hdr->hdr_len,
                                    blob_len - hdr->hdr_len);
    if (calc != hdr->payload_crc) {
        return -5;
    }
    return 0;
}

char *fw_find_name(const fw_hdr_t *hdr)
{
    for (int i = 0; i < 15; i++) {
        if (hdr->name[i] == '\0') {
            return (char *)&hdr->name[i];
        }
    }
    return NULL;
}

int fw_check_flag(const fw_hdr_t *hdr, uint8_t bit)
{
    if (bit > 7) {
        return -1;
    }
    return (hdr->flags & (1u << bit)) != 0;
}

uint32_t fw_rollback_key(uint32_t seed)
{
    uint32_t x = seed ^ 0x9e3779b9u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x + VERSION_MAGIC;
}

static int log_line(const char *level, const char *msg)
{
    const char prefix[] = "[fw] ";
    size_t n = 0;
    char out[96];
    for (size_t i = 0; prefix[i]; i++) out[n++] = prefix[i];
    while (*level && n < sizeof(out) - 1) out[n++] = *level++;
    out[n++] = ':';
    while (*msg && n < sizeof(out) - 1) out[n++] = *msg++;
    out[n] = '\0';
    return (int)n;
}

void fw_log_info(const char *msg)  { log_line("info", msg); }
void fw_log_warn(const char *msg)  { log_line("warn", msg); }
void fw_log_error(const char *msg) { log_line("error", msg); }

// Entry-ish function with a switch and loop.
int fw_dispatch(uint8_t cmd, const uint8_t *in, size_t in_len)
{
    int rc = 0;
    switch (cmd) {
    case 0x10:
        rc = fw_check_flag((const fw_hdr_t *)in, 0);
        break;
    case 0x20:
        rc = (int)fw_crc32_update(0, in, in_len);
        break;
    case 0x30:
        rc = (int)fw_rollback_key((uint32_t)in_len);
        break;
    default:
        fw_log_error("unknown command");
        rc = -100;
        break;
    }
    return rc;
}

// Data with strings for xref/string scanning.
const char *fw_version_string(void)
{
    return "patchdiff-firmware 1.0";
}
