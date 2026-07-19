'use server';

import { revalidatePath } from 'next/cache';

async function call(
  path: string,
  method: 'POST' | 'DELETE' | 'PATCH',
  body?: unknown,
): Promise<void> {
  const api = process.env.API_INTERNAL_URL ?? 'http://guildpay-api:3001';
  const token = process.env.ADMIN_API_TOKEN ?? '';
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      'x-admin-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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

/** Update a user's editable profile/status/KYC fields from the detail-page form. */
export async function updateUser(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const patch: Record<string, string> = {};
  for (const key of ['full_name', 'email', 'status', 'kyc_status']) {
    const v = formData.get(key);
    if (v !== null) patch[key] = String(v);
  }
  await call(`/v1/admin/users/${id}`, 'PATCH', patch);
  revalidatePath(`/users/${id}`);
  revalidatePath('/users');
}

export async function deleteBeneficiary(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const beneficiaryId = String(formData.get('beneficiaryId'));
  await call(`/v1/admin/users/${id}/beneficiaries/${beneficiaryId}`, 'DELETE');
  revalidatePath(`/users/${id}`);
}
