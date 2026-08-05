/**
 * Test fixtures — a small, hand-controlled roster/customer set distinct from
 * the demo seed (src/db/seed.ts). Deliberately constraining like the real
 * seed: exactly one gas-certified tech per county, one inactive tech to
 * prove the active filter, so skill/county matching in tests exercises real
 * logic rather than trivially succeeding.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { customers, technicians, equipment } from '../../src/db/schema.js';

export async function resetDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE tool_invocations, emergency_flags, conversations, appointments, equipment, customers, technicians, sms_opt_outs RESTART IDENTITY CASCADE`,
  );
}

export interface Fixtures {
  techCobbGasId: string;
  techCobbNoGasId: string;
  techCherokeeGasId: string;
  techInactiveId: string;
  customerId: string;
  customerPhone: string;
  equipmentId: string;
}

export async function seedFixtures(): Promise<Fixtures> {
  const techCobbGas = {
    id: randomUUID(),
    name: 'Marcus Webb',
    homeCounty: 'Cobb',
    skills: ['residential', 'gas', 'diagnostics'],
    active: true,
  };
  const techCobbNoGas = {
    id: randomUUID(),
    name: 'Dana Ferris',
    homeCounty: 'Cobb',
    skills: ['residential', 'electrical'],
    active: true,
  };
  const techCherokeeGas = {
    id: randomUUID(),
    name: 'Sofia Reyes',
    homeCounty: 'Cherokee',
    skills: ['residential', 'gas'],
    active: true,
  };
  const techInactive = {
    id: randomUUID(),
    name: 'Renata Kim',
    homeCounty: 'Cobb',
    skills: ['residential', 'gas', 'commercial'],
    active: false,
  };

  await db.insert(technicians).values([techCobbGas, techCobbNoGas, techCherokeeGas, techInactive]);

  const [customer] = await db
    .insert(customers)
    .values({
      phone: '+17705559999',
      name: 'Test Customer',
      addressLine: '100 Test Ln',
      city: 'Marietta',
      county: 'Cobb',
      propertyType: 'residential',
      membershipTier: 'comfort_club',
    })
    .returning();
  if (!customer) throw new Error('fixture customer insert failed');

  const [equip] = await db
    .insert(equipment)
    .values({
      customerId: customer.id,
      kind: 'heat_pump',
      installYear: 2019,
      lastServiceAt: new Date('2025-03-01T00:00:00Z'),
    })
    .returning();
  if (!equip) throw new Error('fixture equipment insert failed');

  return {
    techCobbGasId: techCobbGas.id,
    techCobbNoGasId: techCobbNoGas.id,
    techCherokeeGasId: techCherokeeGas.id,
    techInactiveId: techInactive.id,
    customerId: customer.id,
    customerPhone: customer.phone,
    equipmentId: equip.id,
  };
}
