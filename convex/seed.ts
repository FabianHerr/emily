import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// The demo watch. Run once: npx convex run seed:seedDevice
const DEMO_DEVICE_ID = "watch-1";
const DEMO_PERSON_NAME = "Rosa";
// Upper bound when reading a device's family members.
const MAX_FAMILY_MEMBERS = 50;

export const seedDevice = internalMutation({
  args: {},
  returns: v.id("devices"),
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", DEMO_DEVICE_ID))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("devices", {
      deviceId: DEMO_DEVICE_ID,
      personName: DEMO_PERSON_NAME,
    });
  },
});

// Run by a human with a real key, e.g.:
// npx convex run seed:addFamilyMember '{"name":"Lucie","pushoverUserKey":"<key>","deviceId":"watch-1"}'
// Running it again with the same name and deviceId updates the key instead of adding a copy.
export const addFamilyMember = internalMutation({
  args: { name: v.string(), pushoverUserKey: v.string(), deviceId: v.string() },
  returns: v.id("familyMembers"),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (!device) throw new Error(`Unknown device: ${args.deviceId}`);

    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    const existing = members.find((m) => m.name === args.name);
    if (existing) {
      await ctx.db.patch("familyMembers", existing._id, {
        pushoverUserKey: args.pushoverUserKey,
      });
      return existing._id;
    }
    return await ctx.db.insert("familyMembers", args);
  },
});
