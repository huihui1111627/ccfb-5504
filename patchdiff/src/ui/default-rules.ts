// Built-in starter rules demonstrating the supported YARA subset. Users can
// edit these in the scanner page or add their own.
import type { ScanRule } from '../core/types';

export const DEFAULT_RULES: ScanRule[] = [
  {
    identifier: 'firmware_magic',
    source: `rule firmware_magic {
    meta:
        description = "firmware header magic 0x46573100"
    strings:
        $magic = { 00 31 57 46 }
    condition:
        $magic
}`,
  },
  {
    identifier: 'stack_frame_prologue',
    source: `rule stack_frame_prologue {
    strings:
        $frame = { 55 48 89 e5 }
    condition:
        $frame
}`,
  },
  {
    identifier: 'version_string',
    source: `rule version_string {
    strings:
        $v = "patchdiff-firmware"
    condition:
        $v
}`,
  },
  {
    identifier: 'suspicious_xor_roll',
    source: `rule suspicious_xor_roll {
    strings:
        $a = { 31 ?? }
        $b = { 4? 31 }
    condition:
        any of them
}`,
  },
];
