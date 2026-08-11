export interface FileTypeResult {
  ext: string;
  mime: string;
  isExecutable: boolean;
  confidence: 'magic_bytes' | 'shebang' | 'text_heuristic' | 'fallback';
  interpreter?: string;
}

const SHEBANG_EXTS: Record<string, { ext: string; mime: string }> = {
  python3: { ext: 'py', mime: 'text/x-python' },
  python: { ext: 'py', mime: 'text/x-python' },
  node: { ext: 'js', mime: 'text/javascript' },
  bash: { ext: 'sh', mime: 'text/x-shellscript' },
  sh: { ext: 'sh', mime: 'text/x-shellscript' },
  zsh: { ext: 'sh', mime: 'text/x-shellscript' },
  ruby: { ext: 'rb', mime: 'text/x-ruby' },
  perl: { ext: 'pl', mime: 'text/x-perl' },
  php: { ext: 'php', mime: 'text/x-php' }
};

export function parseShebang(line: string): { interpreter: string; program: string } {
  const interpreter = line.replace(/^#!\s*/, '').trim();
  const tokens = interpreter.split(/\s+/);
  const first = tokens[0] ?? '';
  const name = first.split('/').pop() ?? first;
  if (name === 'env') {
    const next = tokens.slice(1).find((t) => !t.startsWith('-'));
    return { interpreter, program: (next ?? '').split('/').pop() ?? '' };
  }
  return { interpreter, program: name };
}

/**
 * Inspects raw magic bytes (file signature) to detect real file format regardless of extension.
 * Prevents file type spoofing attacks (e.g. executable disguised as image).
 */
export function detectFileType(data: Uint8Array | string): FileTypeResult {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    const encoder = new TextEncoder();
    bytes = encoder.encode(data.substring(0, 64));
  } else {
    bytes = data.subarray(0, 64);
  }

  if (!bytes || bytes.length === 0) {
    return { ext: 'txt', mime: 'text/plain', isExecutable: false, confidence: 'fallback' };
  }

  // Helper to match hex signatures
  const matchHex = (hexArray: number[]): boolean => {
    if (bytes.length < hexArray.length) return false;
    for (let i = 0; i < hexArray.length; i++) {
      if (bytes[i] !== hexArray[i]) return false;
    }
    return true;
  };

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (matchHex([0x89, 0x50, 0x4E, 0x47])) {
    return { ext: 'png', mime: 'image/png', isExecutable: false, confidence: 'magic_bytes' };
  }

  // 2. JPEG: FF D8 FF
  if (matchHex([0xFF, 0xD8, 0xFF])) {
    return { ext: 'jpg', mime: 'image/jpeg', isExecutable: false, confidence: 'magic_bytes' };
  }

  // 3. GIF: 47 49 46 38
  if (matchHex([0x47, 0x49, 0x46, 0x38])) {
    return { ext: 'gif', mime: 'image/gif', isExecutable: false, confidence: 'magic_bytes' };
  }

  // 4. PDF: 25 50 44 46 (%PDF)
  if (matchHex([0x25, 0x50, 0x44, 0x46])) {
    return { ext: 'pdf', mime: 'application/pdf', isExecutable: false, confidence: 'magic_bytes' };
  }

  // 5. ZIP / JAR / DOCX: 50 4B 03 04 (PK..)
  if (matchHex([0x50, 0x4B, 0x03, 0x04])) {
    return { ext: 'zip', mime: 'application/zip', isExecutable: false, confidence: 'magic_bytes' };
  }

  // 6. ELF Executable (Linux): 7F 45 4C 46 (.ELF)
  if (matchHex([0x7F, 0x45, 0x4C, 0x46])) {
    return { ext: 'elf', mime: 'application/x-executable', isExecutable: true, confidence: 'magic_bytes' };
  }

  // 7. Windows PE / EXE: 4D 5A (MZ)
  if (matchHex([0x4D, 0x5A])) {
    return { ext: 'exe', mime: 'application/x-msdownload', isExecutable: true, confidence: 'magic_bytes' };
  }

  // 8. WASM: 00 61 73 6D (\0asm)
  if (matchHex([0x00, 0x61, 0x73, 0x6D])) {
    return { ext: 'wasm', mime: 'application/wasm', isExecutable: true, confidence: 'magic_bytes' };
  }

  // 9. Shebang scripts (#!interpreter) — امتداد/لغة مجهولة لكن المفسّر صريح في أول سطر
  if (bytes[0] === 0x23 && bytes[1] === 0x21) {
    const line = new TextDecoder('utf-8', { fatal: false }).decode(bytes).split(/\r?\n/, 1)[0] ?? '';
    const { interpreter, program } = parseShebang(line);
    const mapped = SHEBANG_EXTS[program];
    return {
      ext: mapped?.ext ?? 'txt',
      mime: mapped?.mime ?? 'text/plain',
      isExecutable: true,
      confidence: 'shebang',
      interpreter
    };
  }

  // Text Heuristics
  const strSample = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  if (strSample.startsWith('{') || strSample.startsWith('[')) {
    return { ext: 'json', mime: 'application/json', isExecutable: false, confidence: 'text_heuristic' };
  }

  if (strSample.startsWith('<!DOCTYPE') || strSample.startsWith('<html')) {
    return { ext: 'html', mime: 'text/html', isExecutable: false, confidence: 'text_heuristic' };
  }

  // Unknown binary content (control bytes beyond whitespace) → honest bin type
  for (const b of bytes) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      return { ext: 'bin', mime: 'application/octet-stream', isExecutable: false, confidence: 'fallback' };
    }
  }

  return { ext: 'txt', mime: 'text/plain', isExecutable: false, confidence: 'fallback' };
}
