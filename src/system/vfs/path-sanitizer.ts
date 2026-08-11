import { Result, ok, err } from '../../kernel/core/result';

export type SanitizedPath = string & { readonly __brand: unique symbol };

/**
 * Path Sanitizer utility to defend against Path Traversal attacks, Null-Byte injections,
 * and Root Jail Escapes.
 */
export function sanitizePath(rawPath: string, rootDir = '/vfs'): Result<SanitizedPath, Error> {
  if (!rawPath || typeof rawPath !== 'string') {
    return err(new Error('EINVALID_PATH: Path must be a non-empty string'));
  }

  // 1. Defend against Null Byte Injections
  if (rawPath.includes('\0') || rawPath.includes('%00')) {
    return err(new Error('ESECURITY_VIOLATION: Path contains illegal null byte injection'));
  }

  // 2. Decode URL Encoded Traversal Sequences (%2e%2e, %2f, %5c)
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // If decoding fails, keep rawPath for inspection
  }

  // 3. Normalize slashes
  let normalized = decoded.replace(/\\/g, '/');

  // 4. Strip rootDir prefix if present to normalize relative checking
  const cleanRoot = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.startsWith(cleanRoot)) {
    normalized = normalized.substring(cleanRoot.length);
  }

  // 5. Check for explicit path traversal components
  const segments = normalized.split('/').filter(Boolean);
  const safeSegments: string[] = [];

  for (const segment of segments) {
    if (segment === '.' || segment === '') {
      continue;
    }
    if (segment === '..') {
      if (safeSegments.length === 0) {
        return err(new Error(`ESECURITY_VIOLATION: Path traversal attempted out of root jail '${rootDir}'`));
      }
      safeSegments.pop();
    } else {
      // Reject suspicious Windows stream descriptors or reserved filenames
      if (segment.includes(':') || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment)) {
        return err(new Error(`ESECURITY_VIOLATION: Path contains reserved or dangerous segment '${segment}'`));
      }
      safeSegments.push(segment);
    }
  }

  const finalSanitized = `${cleanRoot}/${safeSegments.join('/')}`.replace(/\/+/g, '/');
  
  if (!finalSanitized.startsWith(cleanRoot)) {
    return err(new Error(`ESECURITY_VIOLATION: Sanitized path '${finalSanitized}' escapes root jail '${rootDir}'`));
  }

  return ok(finalSanitized as SanitizedPath);
}
