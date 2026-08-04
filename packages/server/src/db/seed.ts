/**
 * Demo-critical seed data (BUILD_GUIDE §2). Investment here matters as much as
 * the tool layer: an empty calendar makes availability checks trivial and
 * skill matching decorative. This seed makes both bite.
 *
 * - ~25 synthetic customers across three counties, mixed membership tiers,
 *   several with 2-3 equipment records and past service dates.
 * - 10 technicians with deliberately constraining skills: Paulding has
 *   exactly one gas-certified tech (Colin Vasquez) and only two techs total,
 *   Cherokee has exactly one (Sofia Reyes). One tech is seeded inactive to
 *   prove the roster filters on it.
 * - A partially-filled board for today through the next five days, generated
 *   with a seeded PRNG so re-running `db:seed` after `db:reset` reproduces the
 *   same board — useful for a repeatable demo.
 * - All synthetic. 555-exchange numbers, `+1770555XXXX` in the reserved
 *   fictitious 0100-0199 block. Maria Delgado (+17705550100) is reserved for
 *   the evaluator to demo returning-caller recognition on demand — same
 *   name/equipment BUILD_GUIDE uses as its own worked example.
 *
 * Only customers/equipment/technicians/appointments are seeded.
 * emergency_flags, conversations, and tool_invocations start empty; they're
 * only ever written by a live call or sim run.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, queryClient } from './client.js';
import { customers, equipment, technicians, appointments } from './schema.js';
import type { NewCustomer, Equipment, Technician, NewAppointment } from './schema.js';
import type { County } from '../domain/constants.js';

// ---------------------------------------------------------------- utilities

/** Deterministic PRNG so reseeding produces the same board every time. */
function mulberry32(seed: number) {
  let s = seed;
  return function next(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260804);

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function atHour(baseDate: Date, hour: number): Date {
  const d = new Date(baseDate);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function today(offsetDays = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d;
}

// ------------------------------------------------------------ technicians
//
// Cobb (largest county): 4 active, redundant gas coverage, plus one inactive.
// Cherokee: 3 active, exactly one gas-certified (Sofia Reyes).
// Paulding: 2 active, exactly one gas-certified (Colin Vasquez) — the
// deliberately tight case BUILD_GUIDE calls out: one county, one gas tech.

interface TechSeed {
  name: string;
  homeCounty: County;
  skills: string[];
  active: boolean;
}

const TECHNICIANS: TechSeed[] = [
  {
    name: 'Marcus Webb',
    homeCounty: 'Cobb',
    skills: ['residential', 'gas', 'diagnostics'],
    active: true,
  },
  {
    name: 'Dana Ferris',
    homeCounty: 'Cobb',
    skills: ['residential', 'electrical', 'diagnostics'],
    active: true,
  },
  {
    name: 'Tyrell Osei',
    homeCounty: 'Cobb',
    skills: ['commercial', 'refrigerant_epa', 'diagnostics', 'gas'],
    active: true,
  },
  {
    name: 'Priya Chandran',
    homeCounty: 'Cobb',
    skills: ['residential', 'install', 'diagnostics'],
    active: true,
  },
  {
    name: 'Renata Kim',
    homeCounty: 'Cobb',
    skills: ['residential', 'commercial', 'gas', 'refrigerant_epa'],
    active: false,
  },

  {
    name: 'Wesley Hartmann',
    homeCounty: 'Cherokee',
    skills: ['residential', 'electrical', 'diagnostics'],
    active: true,
  },
  {
    name: 'Sofia Reyes',
    homeCounty: 'Cherokee',
    skills: ['residential', 'gas', 'install'],
    active: true,
  },
  {
    name: 'Aiden Kowalski',
    homeCounty: 'Cherokee',
    skills: ['commercial', 'refrigerant_epa', 'diagnostics'],
    active: true,
  },

  {
    name: 'Nate Brubaker',
    homeCounty: 'Paulding',
    skills: ['residential', 'electrical', 'diagnostics'],
    active: true,
  },
  {
    name: 'Colin Vasquez',
    homeCounty: 'Paulding',
    skills: ['gas', 'residential', 'diagnostics'],
    active: true,
  },
];

// -------------------------------------------------------------- customers

type MembershipTier = 'basic' | 'comfort_club' | null;

interface CustomerSeed {
  name: string;
  phoneSuffix: string; // last 4 digits, block 0100-0199
  city: string;
  county: County;
  propertyType: 'residential' | 'commercial';
  membershipTier: MembershipTier;
  equipment: {
    kind: Equipment['kind'];
    installYear: number;
    lastServiceDaysAgo: number | null;
    notes?: string;
  }[];
}

/** Reserved for the evaluator — a live demo of returning-caller recognition. */
export const EVALUATOR_PHONE = '+17705550100';

const CUSTOMERS: CustomerSeed[] = [
  // --- Cobb ---
  {
    name: 'Maria Delgado',
    phoneSuffix: '0100',
    city: 'Marietta',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: 'comfort_club',
    equipment: [
      {
        kind: 'heat_pump',
        installYear: 2019,
        lastServiceDaysAgo: 150,
        notes: 'Annual tune-up, system healthy.',
      },
    ],
  },
  {
    name: 'James Whitfield',
    phoneSuffix: '0101',
    city: 'Smyrna',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'central_ac', installYear: 2015, lastServiceDaysAgo: 400 }],
  },
  {
    name: 'Renee Castellano',
    phoneSuffix: '0102',
    city: 'Kennesaw',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [
      { kind: 'furnace', installYear: 2011, lastServiceDaysAgo: 200 },
      { kind: 'central_ac', installYear: 2011, lastServiceDaysAgo: 200 },
    ],
  },
  {
    name: 'Booker Sims',
    phoneSuffix: '0103',
    city: 'Austell',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'heat_pump', installYear: 2020, lastServiceDaysAgo: null }],
  },
  {
    name: 'Priya Nair',
    phoneSuffix: '0104',
    city: 'Marietta',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: 'comfort_club',
    equipment: [{ kind: 'mini_split', installYear: 2022, lastServiceDaysAgo: 60 }],
  },
  {
    name: 'Harold Voss',
    phoneSuffix: '0105',
    city: 'Smyrna',
    county: 'Cobb',
    propertyType: 'commercial',
    membershipTier: null,
    equipment: [{ kind: 'rooftop_unit', installYear: 2017, lastServiceDaysAgo: 300 }],
  },
  {
    name: 'Camille Okafor',
    phoneSuffix: '0106',
    city: 'Kennesaw',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [{ kind: 'furnace', installYear: 2016, lastServiceDaysAgo: 90 }],
  },
  {
    name: 'Douglas Ferry',
    phoneSuffix: '0107',
    city: 'Marietta',
    county: 'Cobb',
    propertyType: 'commercial',
    membershipTier: 'comfort_club',
    equipment: [
      {
        kind: 'rooftop_unit',
        installYear: 2019,
        lastServiceDaysAgo: 120,
        notes: 'Unit A, strip mall — multi-unit property',
      },
      {
        kind: 'rooftop_unit',
        installYear: 2019,
        lastServiceDaysAgo: 120,
        notes: 'Unit B, strip mall — multi-unit property',
      },
    ],
  },
  {
    name: 'Alicia Munroe',
    phoneSuffix: '0108',
    city: 'Austell',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'central_ac', installYear: 2013, lastServiceDaysAgo: 500 }],
  },
  {
    name: 'Grant Palacios',
    phoneSuffix: '0109',
    city: 'Kennesaw',
    county: 'Cobb',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [{ kind: 'heat_pump', installYear: 2018, lastServiceDaysAgo: null }],
  },

  // --- Cherokee ---
  {
    name: 'Ingrid Solano',
    phoneSuffix: '0110',
    city: 'Canton',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: 'comfort_club',
    equipment: [
      { kind: 'furnace', installYear: 2014, lastServiceDaysAgo: 100 },
      { kind: 'central_ac', installYear: 2014, lastServiceDaysAgo: 100 },
    ],
  },
  {
    name: 'Marcus Yeboah',
    phoneSuffix: '0111',
    city: 'Woodstock',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'central_ac', installYear: 2019, lastServiceDaysAgo: 45 }],
  },
  {
    name: 'Bettina Cruz',
    phoneSuffix: '0112',
    city: 'Holly Springs',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [{ kind: 'furnace', installYear: 2009, lastServiceDaysAgo: 250 }],
  },
  {
    name: 'Oren Kessler',
    phoneSuffix: '0113',
    city: 'Canton',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'heat_pump', installYear: 2021, lastServiceDaysAgo: null }],
  },
  {
    name: 'Naomi Fitch',
    phoneSuffix: '0114',
    city: 'Woodstock',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: 'comfort_club',
    equipment: [{ kind: 'mini_split', installYear: 2020, lastServiceDaysAgo: 30 }],
  },
  {
    name: 'Desmond Okonkwo',
    phoneSuffix: '0115',
    city: 'Holly Springs',
    county: 'Cherokee',
    propertyType: 'commercial',
    membershipTier: null,
    equipment: [{ kind: 'rooftop_unit', installYear: 2015, lastServiceDaysAgo: 365 }],
  },
  {
    name: 'Lucia Marchetti',
    phoneSuffix: '0116',
    city: 'Canton',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [{ kind: 'furnace', installYear: 2017, lastServiceDaysAgo: 80 }],
  },
  {
    name: 'Perry Aldana',
    phoneSuffix: '0117',
    city: 'Woodstock',
    county: 'Cherokee',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'central_ac', installYear: 2010, lastServiceDaysAgo: 600 }],
  },

  // --- Paulding ---
  {
    name: 'Whitley Doss',
    phoneSuffix: '0118',
    city: 'Dallas',
    county: 'Paulding',
    propertyType: 'residential',
    membershipTier: 'comfort_club',
    equipment: [
      {
        kind: 'furnace',
        installYear: 2013,
        lastServiceDaysAgo: 200,
        notes: 'Natural gas furnace.',
      },
    ],
  },
  {
    name: 'Rafael Iniguez',
    phoneSuffix: '0119',
    city: 'Hiram',
    county: 'Paulding',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'heat_pump', installYear: 2022, lastServiceDaysAgo: 20 }],
  },
  {
    name: 'Colette Nkemelu',
    phoneSuffix: '0120',
    city: 'New Hope',
    county: 'Paulding',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [
      {
        kind: 'furnace',
        installYear: 2008,
        lastServiceDaysAgo: 300,
        notes: 'Natural gas furnace.',
      },
    ],
  },
  {
    name: 'Tobias Renner',
    phoneSuffix: '0121',
    city: 'Dallas',
    county: 'Paulding',
    propertyType: 'residential',
    membershipTier: null,
    equipment: [{ kind: 'central_ac', installYear: 2016, lastServiceDaysAgo: null }],
  },
  {
    name: 'Fern Ubaldo',
    phoneSuffix: '0122',
    city: 'Hiram',
    county: 'Paulding',
    propertyType: 'commercial',
    membershipTier: null,
    equipment: [{ kind: 'rooftop_unit', installYear: 2018, lastServiceDaysAgo: 150 }],
  },
  {
    name: 'Garrick Novotny',
    phoneSuffix: '0123',
    city: 'New Hope',
    county: 'Paulding',
    propertyType: 'residential',
    membershipTier: 'basic',
    equipment: [
      {
        kind: 'furnace',
        installYear: 2012,
        lastServiceDaysAgo: 400,
        notes: 'Natural gas furnace.',
      },
    ],
  },
  {
    name: 'Selah Kwan',
    phoneSuffix: '0124',
    city: 'Dallas',
    county: 'Paulding',
    propertyType: 'residential',
    membershipTier: 'comfort_club',
    equipment: [
      { kind: 'heat_pump', installYear: 2017, lastServiceDaysAgo: 90 },
      { kind: 'mini_split', installYear: 2020, lastServiceDaysAgo: 90 },
    ],
  },
];

// ------------------------------------------------------------- appointments

const ROUTINE_ISSUES = [
  'Annual maintenance tune-up',
  'Routine filter and coil check',
  'Furnace making an intermittent noise, not urgent',
  'AC blowing warm on hot afternoons, minor',
  'Scheduled seasonal inspection',
  'Thermostat behaving inconsistently',
];

const PRIORITY_ISSUES = [
  'No heat reported, elderly occupant in home',
  'No AC, resident has a respiratory condition',
  'Furnace short-cycling during cold snap',
  'AC down during a heat advisory',
];

const BOARD_DAYS = 6; // today .. today+5
const SLOTS = [8, 10, 12, 14, 16] as const; // 2-hour windows, 8am-6pm

async function main() {
  console.log('Resetting seed tables...');
  await db.execute(
    sql`TRUNCATE TABLE tool_invocations, emergency_flags, conversations, appointments, equipment, customers, technicians RESTART IDENTITY CASCADE`,
  );

  console.log('Seeding technicians...');
  const techRows: Technician[] = TECHNICIANS.map((t) => ({
    id: randomUUID(),
    name: t.name,
    homeCounty: t.homeCounty,
    skills: t.skills,
    active: t.active,
  }));
  await db.insert(technicians).values(techRows);

  console.log('Seeding customers and equipment...');
  const customerRows: NewCustomer[] = [];
  const equipmentByCustomerId = new Map<string, Equipment[]>();
  const customerIdByCounty = new Map<County, string[]>();

  for (const c of CUSTOMERS) {
    const id = randomUUID();
    customerRows.push({
      id,
      phone: `+1770555${c.phoneSuffix}`,
      name: c.name,
      addressLine: `${100 + Number(c.phoneSuffix)} ${['Oak Ridge Rd', 'Maple Grove Ln', 'Highway 9', 'Cedar Hollow Dr', 'Bell Creek Way'][Number(c.phoneSuffix) % 5]}`,
      city: c.city,
      county: c.county,
      propertyType: c.propertyType,
      membershipTier: c.membershipTier,
      dnc: false,
    });
    const equipRows = c.equipment.map((e) => ({
      id: randomUUID(),
      customerId: id,
      kind: e.kind,
      installYear: e.installYear,
      lastServiceAt: e.lastServiceDaysAgo == null ? null : daysAgo(e.lastServiceDaysAgo),
      notes: e.notes ?? null,
    }));
    equipmentByCustomerId.set(id, equipRows as unknown as Equipment[]);
    const list = customerIdByCounty.get(c.county) ?? [];
    list.push(id);
    customerIdByCounty.set(c.county, list);
  }
  await db.insert(customers).values(customerRows);
  const allEquipment = [...equipmentByCustomerId.values()].flat();
  if (allEquipment.length > 0) {
    await db.insert(equipment).values(
      allEquipment.map((e) => ({
        id: e.id,
        customerId: e.customerId,
        kind: e.kind,
        installYear: e.installYear,
        lastServiceAt: e.lastServiceAt,
        notes: e.notes,
      })),
    );
  }

  console.log('Generating dispatch board...');
  const appointmentRows: NewAppointment[] = [];
  const cursorByCounty = new Map<County, number>();

  for (const tech of techRows.filter((t) => t.active)) {
    const county = tech.homeCounty as County;
    const pool = customerIdByCounty.get(county) ?? [];
    if (pool.length === 0) continue;

    for (let day = 0; day < BOARD_DAYS; day++) {
      // Colin Vasquez is the only gas-certified tech in Paulding — book him
      // heavily for the next two days so an emergency gas call there hits
      // genuine scarcity, not a trivially empty calendar.
      const isScarceGasTech = tech.name === 'Colin Vasquez' && day <= 1;
      const fillProbability = isScarceGasTech ? 0.9 : 0.55;

      for (let slotIdx = 0; slotIdx < SLOTS.length; slotIdx++) {
        if (rng() >= fillProbability) continue; // leave the slot open

        const hour = SLOTS[slotIdx]!;
        const dayDate = today(day);
        const customerCursor = cursorByCounty.get(county) ?? 0;
        const customerId = pool[customerCursor % pool.length]!;
        cursorByCounty.set(county, customerCursor + 1);

        const custEquip = equipmentByCustomerId.get(customerId) ?? [];
        const customerSeed = CUSTOMERS.find(
          (c) => customerRows.find((r) => r.id === customerId)?.name === c.name,
        );
        const isCommercial = customerSeed?.propertyType === 'commercial';
        const urgency = rng() < 0.15 ? 'priority' : 'routine';
        const issuePool = urgency === 'priority' ? PRIORITY_ISSUES : ROUTINE_ISSUES;
        const issueSummary = issuePool[Math.floor(rng() * issuePool.length)]!;

        const requiredSkills = [isCommercial ? 'commercial' : 'residential', 'diagnostics'];
        if (tech.skills.includes('gas') && rng() < 0.3) requiredSkills.push('gas');
        if (tech.skills.includes('refrigerant_epa') && rng() < 0.3)
          requiredSkills.push('refrigerant_epa');

        appointmentRows.push({
          id: randomUUID(),
          customerId,
          technicianId: tech.id,
          scheduledStart: atHour(dayDate, hour),
          scheduledEnd: atHour(dayDate, hour + 2),
          urgency,
          issueSummary,
          equipmentId: custEquip[0]?.id ?? null,
          requiredSkills,
          // First slot of today reads as already in progress, so the board
          // looks like a live operations day rather than an untouched seed.
          status: day === 0 && slotIdx === 0 ? 'dispatched' : 'booked',
          sourceChannel: rng() < 0.8 ? 'voice' : 'sms',
          sourceCallId: `seed-${tech.id.slice(0, 8)}-${day}-${slotIdx}`,
        });
      }
    }
  }

  await db.insert(appointments).values(appointmentRows);

  console.log(
    `Seeded ${techRows.length} technicians, ${customerRows.length} customers, ` +
      `${allEquipment.length} equipment records, ${appointmentRows.length} appointments.`,
  );
  console.log(`Evaluator demo number: ${EVALUATOR_PHONE} (Maria Delgado — Comfort Club, Cobb).`);
}

await main();
await queryClient.end();
