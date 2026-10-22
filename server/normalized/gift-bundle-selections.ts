import { z } from 'zod'

/** The same one-selection-per-physical-bundle shape as ordinary ordering. */
export const giftBundleSelectionsSchema = z.array(z.object({
  groups: z.array(z.object({
    groupId: z.string().uuid(), productIds: z.array(z.string().uuid()).min(1).max(20),
  }).strict()).min(1).max(20),
}).strict()).max(100)
