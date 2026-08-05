import type { DashboardState } from '../types/api';

const BASE_URL = import.meta.env.VITE_API_BASE_URL;

export function eventsUrl(): string {
  return `${BASE_URL}/events`;
}

export async function fetchDashboardState(date?: string): Promise<DashboardState> {
  const url = new URL('/dashboard/state', BASE_URL);
  if (date) url.searchParams.set('date', date);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /dashboard/state failed: ${res.status}`);
  return (await res.json()) as DashboardState;
}

export async function acknowledgeEmergency(
  id: string,
): Promise<{ ok: true; alreadyAcknowledged: boolean; acknowledgedAt: string }> {
  const res = await fetch(`${BASE_URL}/dashboard/emergencies/${id}/acknowledge`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`POST acknowledge failed: ${res.status}`);
  return (await res.json()) as { ok: true; alreadyAcknowledged: boolean; acknowledgedAt: string };
}
