import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}}));

const {packedPhotoPathOk} = await import("../src/services/packedPhoto");

describe("sealed-packet photo", () => {
  it("accepts only the staff member's own photo for that order", () => {
    expect(packedPhotoPathOk("private/packed-orders/r1/staff1/ord9-1760000000000.jpg", "r1", "staff1", "ord9")).toBe(true);
    expect(packedPhotoPathOk("private/packed-orders/r2/staff1/ord9-1760000000000.jpg", "r1", "staff1", "ord9")).toBe(false);
    expect(packedPhotoPathOk("private/packed-orders/r1/other/ord9-1760000000000.jpg", "r1", "staff1", "ord9")).toBe(false);
    expect(packedPhotoPathOk("private/packed-orders/r1/staff1/ord8-1760000000000.jpg", "r1", "staff1", "ord9")).toBe(false);
    expect(packedPhotoPathOk("restaurants/r1/users/staff1/cover/x.jpg", "r1", "staff1", "ord9")).toBe(false);
  });
  it("refuses ids that could break out of the folder", () => {
    expect(packedPhotoPathOk("private/packed-orders/r.*/staff1/ord9-1760000000000.jpg", "r.*", "staff1", "ord9")).toBe(false);
    expect(packedPhotoPathOk("private/packed-orders/r1/staff1/ord9-1760000000000.jpg", "", "staff1", "ord9")).toBe(false);
  });
});
