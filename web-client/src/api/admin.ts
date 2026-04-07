import { apiClient } from './client';

export interface AdminUser {
  userId:    string;
  email:     string;
  username:  string;
  createdAt: string;
  isAdmin?:  boolean;
}

export interface AdminInvite {
  inviteCode:          string;
  createdAt:           string;
  createdBy:           string;
  createdByEmail:      string;
  expiresAt?:          number; // Unix epoch seconds
  note?:               string;
  // Used
  usedAt?:             number; // Unix epoch seconds
  assignedUserId?:     string;
  assignedUserEmail?:  string;
  // Invalidated
  invalidatedAt?:      string;
  invalidatedBy?:      string;
}

export async function adminListUsers(): Promise<AdminUser[]> {
  const res = await apiClient.get<{ users: AdminUser[] }>('/admin/users');
  return res.data.users;
}

export async function adminListInvites(): Promise<AdminInvite[]> {
  const res = await apiClient.get<{ invites: AdminInvite[] }>('/admin/invites');
  return res.data.invites;
}

export async function adminCreateInvite(opts: { expiresInDays?: number; note?: string }): Promise<{ inviteCode: string; expiresAt: number }> {
  const res = await apiClient.post<{ inviteCode: string; expiresAt: number }>('/admin/invites', opts);
  return res.data;
}

export async function adminInvalidateInvite(inviteCode: string): Promise<void> {
  await apiClient.delete(`/admin/invites/${inviteCode}`);
}
