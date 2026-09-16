import ExcelJS from "exceljs";
import {describe, expect, it} from "vitest";
import {
  adminAccountExportRows,
  buildPlatformDataWorkbookBuffer,
  customerExportRows,
  filterRowsByCity,
  restaurantExportRows,
  riderExportRows,
  sanitizeSpreadsheetText,
} from "../src/domain/adminDataExport";

describe("customerExportRows", () => {
  it("maps a fully populated customer record", () => {
    const rows = customerExportRows({
      "uid-1": {
        name: "Asha Rao",
        email: "asha@example.com",
        emailVerified: true,
        phone: "9876543210",
        selectedAddressId: "addr-2",
        addresses: {
          0: {id: "addr-1", area: "Old Town", city: "Nellore", address: "12 Old Town Rd"},
          1: {id: "addr-2", area: "New Town", city: "Nellore", address: "45 New Town Rd"},
        },
        favourites: {"rest-1": true, "rest-2": true},
        preferences: {theme: "dark", vegetarian: true, notifications: false},
        updatedAt: 1_700_000_000_000,
      },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.uid).toBe("uid-1");
    expect(row.name).toBe("Asha Rao");
    expect(row.emailVerified).toBe(true);
    expect(row.addressCount).toBe(2);
    // The selected address (addr-2), not just the first one in the map.
    expect(row.primaryAddress).toBe("45 New Town Rd");
    expect(row.area).toBe("New Town");
    expect(row.favouritesCount).toBe(2);
    expect(row.themePreference).toBe("dark");
    expect(row.notificationsEnabled).toBe(false);
    expect(row.vegetarianPreference).toBe(true);
    expect(row.updatedAt).toBe(1_700_000_000_000);
  });

  it("falls back to the first address when no address is selected", () => {
    const rows = customerExportRows({
      "uid-2": {addresses: {0: {area: "Only Area", address: "Only Street"}}},
    });
    expect(rows[0].area).toBe("Only Area");
  });

  it("never crashes on a sparse or malformed record", () => {
    const rows = customerExportRows({
      "uid-3": {},
      "uid-4": {addresses: "not-an-object", preferences: null, favourites: 42},
      "uid-5": null,
    });
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.addressCount).toBe(0);
      expect(row.name).toBe("");
      expect(row.notificationsEnabled).toBe(true); // default: not explicitly disabled
    });
  });

  it("handles a missing users tree", () => {
    expect(customerExportRows(null)).toEqual([]);
    expect(customerExportRows(undefined)).toEqual([]);
  });
});

describe("riderExportRows", () => {
  it("maps a rider record including masked identity fields", () => {
    const rows = riderExportRows({
      "rider-1": {
        fullName: "Kalyan Masaram",
        email: "kalyan@example.com",
        phone: "9000000000",
        city: "Nellore",
        vehicleType: "bike",
        vehicleNumber: "AP01AB1234",
        aadhaarLast4: "4321",
        panNumber: "ABCDE1234F",
        status: "approved",
        documentsVerified: true,
        approvedAt: 1_700_000_500_000,
        submittedAt: 1_699_000_000_000,
        updatedAt: 1_700_000_600_000,
      },
    });
    expect(rows[0]).toMatchObject({
      uid: "rider-1",
      fullName: "Kalyan Masaram",
      aadhaarLast4: "4321",
      panNumber: "ABCDE1234F",
      status: "approved",
      documentsVerified: true,
    });
  });

  it("never crashes on a malformed record", () => {
    expect(() => riderExportRows({"rider-2": "not-an-object" as unknown as Record<string, unknown>})).not.toThrow();
    expect(riderExportRows(undefined)).toEqual([]);
  });
});

describe("restaurantExportRows", () => {
  it("maps operational fields and the restaurant's real payout credentials", () => {
    const rows = restaurantExportRows({
      "rest-1": {
        name: "The Waffle Spot",
        city: "Naidupeta",
        cuisines: ["Waffle", "Desserts"],
        lat: 13.9018832,
        lng: 79.8877264,
        open: true,
        rating: 4.6,
        deliveryFee: 29,
        platformFee: 15,
        commissionBps: 1200,
        payoutProfile: {
          bankAccountHolderName: "Waffle Spot Pvt Ltd",
          bankAccountNumber: "000111222333",
          bankIfsc: "HDFC0000123",
          bankName: "HDFC Bank",
          accountType: "current",
          upiId: "waffle@upi",
          panNumber: "ABCDE1234F",
        },
      },
    });
    const row = rows[0];
    expect(row.restaurantId).toBe("rest-1");
    expect(row.cuisines).toBe("Waffle, Desserts");
    expect(row.payoutConfigured).toBe(true);
    // Included on explicit owner request - see the note in the Export Info sheet.
    expect(row.payoutBankAccountHolderName).toBe("Waffle Spot Pvt Ltd");
    expect(row.payoutBankAccountNumber).toBe("000111222333");
    expect(row.payoutBankIfsc).toBe("HDFC0000123");
    expect(row.payoutBankName).toBe("HDFC Bank");
    expect(row.payoutAccountType).toBe("current");
    expect(row.payoutUpiId).toBe("waffle@upi");
    expect(row.payoutPanNumber).toBe("ABCDE1234F");
  });

  it("reports payoutConfigured=false and blank payout fields when no payout profile exists", () => {
    const rows = restaurantExportRows({"rest-2": {name: "No Payout Yet"}});
    expect(rows[0].payoutConfigured).toBe(false);
    expect(rows[0].payoutBankAccountNumber).toBe("");
    expect(rows[0].payoutUpiId).toBe("");
  });

  it("never crashes when payoutProfile is malformed", () => {
    expect(() => restaurantExportRows({"rest-3": {payoutProfile: "not-an-object"}})).not.toThrow();
    expect(() => restaurantExportRows({"rest-4": {payoutProfile: null}})).not.toThrow();
  });

  it("treats active as true unless explicitly set false", () => {
    expect(restaurantExportRows({"a": {}})[0].active).toBe(true);
    expect(restaurantExportRows({"a": {active: false}})[0].active).toBe(false);
  });
});

describe("adminAccountExportRows", () => {
  const baseUser = {
    uid: "u1",
    email: "owner@example.com",
    displayName: "Owner",
    disabled: false,
    metadata: {creationTime: "2024-01-01T00:00:00Z", lastSignInTime: "2024-06-01T00:00:00Z"},
  };

  it("includes owner and ops_admin accounts", () => {
    const rows = adminAccountExportRows([
      {...baseUser, uid: "owner-1", customClaims: {savrivoRole: "owner"}},
      {...baseUser, uid: "ops-1", customClaims: {savrivoRole: "ops_admin"}},
    ]);
    expect(rows.map((r) => r.uid)).toEqual(["owner-1", "ops-1"]);
    expect(rows[0].role).toBe("owner");
    expect(rows[1].role).toBe("ops_admin");
  });

  it("excludes every account without a privileged claim", () => {
    const rows = adminAccountExportRows([
      {...baseUser, uid: "customer-1", customClaims: undefined},
      {...baseUser, uid: "customer-2", customClaims: {}},
      {...baseUser, uid: "rider-1", customClaims: {savrivoRole: "rider"}},
      {...baseUser, uid: "staff-1", customClaims: {savrivoRole: "restaurant_staff"}},
    ]);
    expect(rows).toEqual([]);
  });

  it("carries disabled status and sign-in metadata through", () => {
    const rows = adminAccountExportRows([
      {...baseUser, uid: "owner-2", disabled: true, customClaims: {savrivoRole: "owner"}},
    ]);
    expect(rows[0].disabled).toBe(true);
    expect(rows[0].createdAt).toBe("2024-01-01T00:00:00Z");
    expect(rows[0].lastSignInAt).toBe("2024-06-01T00:00:00Z");
  });
});

describe("sanitizeSpreadsheetText", () => {
  it("prefixes formula-triggering characters with an apostrophe", () => {
    expect(sanitizeSpreadsheetText("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(sanitizeSpreadsheetText("+1-234-555")).toBe("'+1-234-555");
    expect(sanitizeSpreadsheetText("-99")).toBe("'-99");
    expect(sanitizeSpreadsheetText("@mention")).toBe("'@mention");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeSpreadsheetText("Asha Rao")).toBe("Asha Rao");
    expect(sanitizeSpreadsheetText("12 Old Town Rd")).toBe("12 Old Town Rd");
    expect(sanitizeSpreadsheetText("")).toBe("");
  });
});

describe("filterRowsByCity", () => {
  const rows = [
    {name: "Asha", city: "Naidupeta"},
    {name: "Kalyan", city: "Nellore"},
    {name: "Priya", city: "naidupeta"}, // same city, different case
    {name: "Ravi", city: "  Nellore  "}, // same city, stray whitespace
    {name: "NoCity", city: ""},
  ];

  it("returns every row when no city is given", () => {
    expect(filterRowsByCity(rows, undefined)).toHaveLength(5);
    expect(filterRowsByCity(rows, null)).toHaveLength(5);
    expect(filterRowsByCity(rows, "")).toHaveLength(5);
    expect(filterRowsByCity(rows, "   ")).toHaveLength(5);
  });

  it("matches case-insensitively", () => {
    const matched = filterRowsByCity(rows, "NAIDUPETA");
    expect(matched.map((r) => r.name)).toEqual(["Asha", "Priya"]);
  });

  it("matches regardless of surrounding whitespace on either side", () => {
    expect(filterRowsByCity(rows, "  nellore  ").map((r) => r.name)).toEqual(["Kalyan", "Ravi"]);
  });

  it("returns nothing for a city that matches no row", () => {
    expect(filterRowsByCity(rows, "Hyderabad")).toEqual([]);
  });

  it("a row with no city never matches a real city filter", () => {
    const matched = filterRowsByCity(rows, "Naidupeta");
    expect(matched.some((r) => r.name === "NoCity")).toBe(false);
  });

  it("does not mutate the input array", () => {
    const copy = rows.slice();
    filterRowsByCity(rows, "Naidupeta");
    expect(rows).toEqual(copy);
  });
});

describe("buildPlatformDataWorkbookBuffer", () => {
  const sampleInput = {
    generatedAt: 1_700_000_000_000,
    generatedByEmail: "owner@example.com",
    customers: customerExportRows({
      c1: {name: "Asha Rao", email: "asha@example.com", phone: "9876543210", updatedAt: 1_700_000_000_000},
    }),
    riders: riderExportRows({
      r1: {fullName: "Kalyan Masaram", status: "approved", updatedAt: 1_700_000_000_000},
    }),
    restaurants: restaurantExportRows({
      rest1: {name: "The Waffle Spot", payoutProfile: {bankAccountNumber: "111222333", upiId: "waffle@upi"}},
    }),
    adminAccounts: adminAccountExportRows([
      {
        uid: "owner-1",
        email: "owner@example.com",
        displayName: "Owner",
        disabled: false,
        customClaims: {savrivoRole: "owner"},
        metadata: {creationTime: "2024-01-01T00:00:00Z", lastSignInTime: "2024-06-01T00:00:00Z"},
      },
    ]),
  };

  it("produces a real workbook with one sheet per segment plus an info sheet", async () => {
    const buffer = await buildPlatformDataWorkbookBuffer(sampleInput);
    expect(buffer.length).toBeGreaterThan(1_000); // a real xlsx zip, not an empty stub

    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const sheetNames = roundTrip.worksheets.map((sheet) => sheet.name);
    expect(sheetNames).toEqual(["Customers", "Riders", "Restaurants", "Admin Accounts", "Export Info"]);
  });

  it("round-trips the header row and every data row correctly", async () => {
    const buffer = await buildPlatformDataWorkbookBuffer(sampleInput);
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);

    const customersSheet = roundTrip.getWorksheet("Customers")!;
    expect(customersSheet.getRow(1).getCell(2).value).toBe("Name"); // header
    expect(customersSheet.getRow(2).getCell(2).value).toBe("Asha Rao"); // data
    expect(customersSheet.rowCount).toBe(2); // header + 1 customer, no phantom rows

    const restaurantsSheet = roundTrip.getWorksheet("Restaurants")!;
    const headerRow = (restaurantsSheet.getRow(1).values as unknown[]).slice(1) as string[];
    const payoutColumn = headerRow.indexOf("Payout Configured") + 1;
    expect(payoutColumn).toBeGreaterThan(0);
    expect(restaurantsSheet.getRow(2).getCell(payoutColumn).value).toBe("Yes");
    // Included on explicit owner request: the real bank account number and UPI
    // id must be present in the sheet, in their own named columns.
    const accountColumn = headerRow.indexOf("Bank Account Number") + 1;
    const upiColumn = headerRow.indexOf("UPI ID") + 1;
    expect(accountColumn).toBeGreaterThan(0);
    expect(upiColumn).toBeGreaterThan(0);
    expect(restaurantsSheet.getRow(2).getCell(accountColumn).value).toBe("111222333");
    expect(restaurantsSheet.getRow(2).getCell(upiColumn).value).toBe("waffle@upi");
  });

  it("writes a real Excel date, not a string, for date columns", async () => {
    const buffer = await buildPlatformDataWorkbookBuffer(sampleInput);
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const customersSheet = roundTrip.getWorksheet("Customers")!;
    const headerRow = (customersSheet.getRow(1).values as unknown[]).slice(1) as string[];
    const updatedColumn = headerRow.indexOf("Last Updated") + 1;
    const cellValue = customersSheet.getRow(2).getCell(updatedColumn).value;
    expect(cellValue).toBeInstanceOf(Date);
    expect((cellValue as Date).getTime()).toBe(1_700_000_000_000);
  });

  it("leaves the date cell blank rather than 1970 when a record has no timestamp", async () => {
    const inputWithoutDates = {
      ...sampleInput,
      riders: riderExportRows({r1: {fullName: "No Timestamp Rider"}}),
    };
    const buffer = await buildPlatformDataWorkbookBuffer(inputWithoutDates);
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const ridersSheet = roundTrip.getWorksheet("Riders")!;
    const headerRow = (ridersSheet.getRow(1).values as unknown[]).slice(1) as string[];
    const updatedColumn = headerRow.indexOf("Last Updated") + 1;
    expect(ridersSheet.getRow(2).getCell(updatedColumn).value).toBeFalsy();
  });

  it("sanitizes a formula-like name before it reaches the sheet", async () => {
    const maliciousInput = {
      ...sampleInput,
      customers: customerExportRows({c1: {name: "=HYPERLINK(\"http://evil\",\"click\")"}}),
    };
    const buffer = await buildPlatformDataWorkbookBuffer(maliciousInput);
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const nameCell = roundTrip.getWorksheet("Customers")!.getRow(2).getCell(2).value;
    expect(String(nameCell)).toMatch(/^'=/);
  });

  it("sanitizes a formula-like value in a payout field too", async () => {
    const maliciousInput = {
      ...sampleInput,
      restaurants: restaurantExportRows({
        rest1: {name: "The Waffle Spot", payoutProfile: {bankName: "=cmd|'/c calc'!A1"}},
      }),
    };
    const buffer = await buildPlatformDataWorkbookBuffer(maliciousInput);
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const restaurantsSheet = roundTrip.getWorksheet("Restaurants")!;
    const headerRow = (restaurantsSheet.getRow(1).values as unknown[]).slice(1) as string[];
    const bankNameColumn = headerRow.indexOf("Bank Name") + 1;
    expect(String(restaurantsSheet.getRow(2).getCell(bankNameColumn).value)).toMatch(/^'=/);
  });

  it("produces an empty-but-valid workbook when every segment is empty", async () => {
    const buffer = await buildPlatformDataWorkbookBuffer({
      generatedAt: Date.now(),
      generatedByEmail: "owner@example.com",
      customers: [],
      riders: [],
      restaurants: [],
      adminAccounts: [],
    });
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    expect(roundTrip.getWorksheet("Customers")!.rowCount).toBe(1); // header only
  });

  it("includes generation metadata and segment counts in the Export Info sheet", async () => {
    const buffer = await buildPlatformDataWorkbookBuffer(sampleInput);
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const info = roundTrip.getWorksheet("Export Info")!;
    const asText = () => {
      const lines: string[] = [];
      info.eachRow((row) => lines.push(row.values ? row.values.toString() : ""));
      return lines.join("\n");
    };
    const text = asText();
    expect(text).toContain("owner@example.com");
    expect(text).toContain("bank account numbers");
    expect(text).toContain("securely");
    expect(text).toContain("All cities"); // no city filter was applied in sampleInput
    expect(text).toContain("not city-scoped"); // admin accounts are never filtered by city
  });

  it("records the applied city filter in the Export Info sheet when one is given", async () => {
    const buffer = await buildPlatformDataWorkbookBuffer({...sampleInput, cityFilter: "Naidupeta"});
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const info = roundTrip.getWorksheet("Export Info")!;
    const rows: string[][] = [];
    info.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map(String)));
    const cityRow = rows.find((r) => r[0] === "City Filter");
    expect(cityRow?.[1]).toBe("Naidupeta");
  });
});
