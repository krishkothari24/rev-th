/**
 * Shared Zod primitives for the tool layer. This is the security boundary
 * BUILD_GUIDE §4 and §8.3 describe: urgency is an enum the model cannot
 * escape, county/skill values are constrained to the real service area and
 * roster vocabulary, and every tool schema below is `.strict()` so a field
 * the model has no business setting (`technician_id`, a price, a membership
 * tier) is a 400, not a silently-accepted write.
 */
import { z } from 'zod';
import { COUNTIES, SKILLS } from '../domain/constants.js';
import { urgencyEnum, propertyTypeEnum, channelEnum, emergencyReasonEnum } from '../db/schema.js';

/** Opaque conversation identifier — Retell call_id, a Twilio conversation id,
 * or a caller-chosen token in sim/curl testing. Never parsed, only hashed. */
export const callIdSchema = z.string().trim().min(1, 'call_id is required').max(200);

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{9,14}$/, 'phone must be E.164, e.g. +17705550100');

export const countySchema = z.enum(COUNTIES);
export const skillSchema = z.enum(SKILLS);
export const urgencySchema = z.enum(urgencyEnum.enumValues);
export const propertyTypeSchema = z.enum(propertyTypeEnum.enumValues);
export const channelSchema = z.enum(channelEnum.enumValues);
export const emergencyReasonSchema = z.enum(emergencyReasonEnum.enumValues);

export const requiredSkillsSchema = z.array(skillSchema).max(SKILLS.length).default([]);
