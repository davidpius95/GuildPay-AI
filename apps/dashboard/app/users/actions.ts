'use server';

import { revalidatePath } from 'next/cache';

const API = process.env.API_INTERNAL_URL ?? 'http://guildpay-api:3001';
const TOKEN = process.env.ADMIN_API_TOKEN ?? '';

async function call(path: string, method: 'POST' | 'DELETE'): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-admin-token': TOKEN },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`admin ${method} ${path} → ${res.status}`);
}

export async function resetUser(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  await call(`/v1/admin/users/${id}/reset`, 'POST');
  revalidatePath('/users');
}

export async function deleteUser(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  await call(`/v1/admin/users/${id}`, 'DELETE');
  revalidatePath('/users');
}

export async function demoReset(): Promise<void> {
  await call('/v1/demo/reset', 'POST');
  revalidatePath('/users');
}
