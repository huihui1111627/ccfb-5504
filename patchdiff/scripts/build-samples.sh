#!/usr/bin/env bash
# Build the sample corpus: clang + (if available) gcc, O0/O2, stripped/unstripped,
# x86-64 and AArch64, relocatable objects and (when lld exists) linked executables.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=samples/bin
SRC=samples/src
mkdir -p "$BIN"

# Discover compilers.
CLANG=clang
GCC_CANDIDATES=(gcc x86_64-linux-gnu-gcc /opt/homebrew/bin/x86_64-unknown-linux-gnu-gcc)
GCC=""
for c in "${GCC_CANDIDATES[@]}"; do
  if command -v "$c" >/dev/null 2>&1 && "$c" --version 2>/dev/null | grep -qi 'gcc'; then GCC="$c"; break; fi
done
# lld for linked Linux ELFs (Apple ld cannot link Linux binaries).
LLD=""
for c in ld.lld /opt/homebrew/opt/llvm/bin/ld.lld; do
  if command -v "$c" >/dev/null 2>&1; then LLD="$c"; break; fi
done

TARGETS=(x86_64-linux-gnu aarch64-linux-gnu)
OPTS=(-O0 -O2)
SRCS=(fw.c fw_patched.c)

build_one() {
  local cc="$1" src="$2" arch="$3" opt="$4" stripped="$5" mode="$6"
  local base; base="$(basename "$src" .c)"
  local ccname; ccname="$(basename "$cc" | sed 's/-.*//;s/\..*//')"
  local archshort; archshort="$(echo "$arch" | cut -d- -f1)"
  local out="$BIN/${base}.${ccname}.${archshort}.${opt#-}.${mode}.${stripped}.o"
  local -a flags=(--target="$arch" "$opt" -fno-omit-frame-pointer -g0 -c "$SRC/$src" -o "$out")
  [[ "$mode" == "pie" ]] && flags+=(-fPIE)
  "$cc" "${flags[@]}"
  if [[ "$stripped" == "stripped" ]]; then
    node --experimental-transform-types scripts/strip-elf.ts "$out" "$out.tmp" >/dev/null && mv "$out.tmp" "$out"
  fi
  echo "$out"
}

count=0
for src in "${SRCS[@]}"; do
  for arch in "${TARGETS[@]}"; do
    for opt in "${OPTS[@]}"; do
      for stripped in unstripped stripped; do
        build_one "$CLANG" "$src" "$arch" "$opt" "$stripped" rel
        count=$((count+1))
        if [[ -n "$GCC" ]]; then
          build_one "$GCC" "$src" "$arch" "$opt" "$stripped" rel || true
          count=$((count+1))
        fi
      done
    done
  done
done

# Linked executables when lld is available.
if [[ -n "$LLD" ]]; then
  for arch in "${TARGETS[@]}"; do
    for opt in "${OPTS[@]}"; do
      for src in "${SRCS[@]}"; do
        base="$(basename "$src" .c)"
        archshort="$(echo "$arch" | cut -d- -f1)"
        out="$BIN/${base}.clang.${archshort}.${opt#-}.exec.o"
        clang --target="$arch" "$opt" -fuse-ld="$LLD" -nostdlib \
          -Wl,-e,fw_dispatch "$SRC/$src" -o "$out" 2>/dev/null || true
      done
    done
  done
fi

echo "built $count object variants into $BIN"
ls -1 "$BIN" | head -40
