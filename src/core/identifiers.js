import { randomBytes, randomUUID } from 'node:crypto';

export function uuid() {
  return randomUUID();
}

export function publicId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error('Slug must use lowercase letters, numbers, and internal hyphens only');
  }
  return slug;
}
