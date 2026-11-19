import type { CrewMemberInput } from "../transportTypes";

/**
 * The people travelling with an own-vehicle load, pure (2026-11-20). The screen's copy
 * of the server's `own_vehicle.crew_problems`, word for word, so the form says what
 * the press would refuse before anybody presses it.
 */
export const MAX_CREW = 20;
const PHONE = /^[6-9]\d{9}$/;

export const digitsOnly = (value: string) => value.replace(/\D/g, "").slice(0, 10);

export function blankPerson(role: CrewMemberInput["role"] = "HELPER"): CrewMemberInput {
  return { role, name: "", phone: "", id_number: "" };
}

/** Grow or shrink the list to `count`, keeping everyone already typed in. The first
 *  person of a new crew is the driver, because every vehicle has one. */
export function resizeCrew(crew: CrewMemberInput[], count: number): CrewMemberInput[] {
  const size = Math.max(0, Math.min(MAX_CREW, Math.floor(count || 0)));
  const next = crew.slice(0, size);
  while (next.length < size) next.push(blankPerson(next.length === 0 ? "DRIVER" : "HELPER"));
  if (next.length && !next.some((p) => p.role === "DRIVER")) next[0] = { ...next[0], role: "DRIVER" };
  return next;
}

/** Make `index` the driver and everyone else a helper — there is one driver. */
export function makeDriver(crew: CrewMemberInput[], index: number): CrewMemberInput[] {
  return crew.map((p, i) => ({ ...p, role: i === index ? "DRIVER" : "HELPER" }));
}

/** Everything wrong with the crew, as sentences, per person where it is about one. */
export function crewProblems(count: number | null | undefined, crew: CrewMemberInput[]): {
  general: string[]; byPerson: Record<number, string[]>;
} {
  const general: string[] = [];
  const byPerson: Record<number, string[]> = {};
  const add = (i: number, message: string) => { (byPerson[i] ??= []).push(message); };
  if (!count || count < 1) {
    return { general: ["Enter how many people are going with the vehicle (at least 1, the driver)."], byPerson };
  }
  if (count > MAX_CREW) return { general: [`At most ${MAX_CREW} people can travel on one vehicle.`], byPerson };
  if (crew.length !== count) {
    general.push(`You said ${count} ${count === 1 ? "person is" : "people are"} going but ${crew.length} ${crew.length === 1 ? "is" : "are"} filled in.`);
  }
  const phones = new Map<string, number>();
  let drivers = 0;
  crew.forEach((person, i) => {
    if (!person.name.trim()) add(i, "Enter the name.");
    const phone = person.phone.replace(/\D/g, "");
    if (!PHONE.test(phone)) add(i, "Enter a 10-digit mobile number.");
    else if (phones.has(phone)) add(i, `This number is already given for person ${phones.get(phone)! + 1}.`);
    else phones.set(phone, i);
    if (person.role === "DRIVER") drivers += 1;
  });
  if (crew.length && drivers === 0) general.push("Mark one person as the driver.");
  if (drivers > 1) general.push("Only one person can be the driver.");
  return { general, byPerson };
}

/** How many problems in all — 0 means the crew can be sent. */
export function crewProblemCount(count: number | null | undefined, crew: CrewMemberInput[]): number {
  const { general, byPerson } = crewProblems(count, crew);
  return general.length + Object.values(byPerson).reduce((n, list) => n + list.length, 0);
}
