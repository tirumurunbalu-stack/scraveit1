import ExcelJS from "exceljs";
import type {UserRecord} from "firebase-admin/auth";

export interface CustomerExportRow {
  uid: string;
  name: string;
  email: string;
  emailVerified: boolean;
  phone: string;
  addressCount: number;
  primaryAddress: string;
  area: string;
  city: string;
  favouritesCount: number;
  themePreference: string;
  notificationsEnabled: boolean;
  vegetarianPreference: boolean;
  updatedAt: number | null;
}

export interface RiderExportRow {
  uid: string;
  fullName: string;
  email: string;
  phone: string;
  city: string;
  address: string;
  vehicleType: string;
  vehicleNumber: string;
  aadhaarLast4: string;
  panNumber: string;
  status: string;
  documentsVerified: boolean;
  approvedAt: number | null;
  submittedAt: number | null;
  updatedAt: number | null;
}

export interface RestaurantExportRow {
  restaurantId: string;
  name: string;
  phone: string;
  city: string;
  category: string;
  cuisines: string;
  address: string;
  lat: number | null;
  lng: number | null;
  open: boolean;
  active: boolean;
  archived: boolean;
  rating: number | null;
  ratingCount: number | null;
  deliveryFee: number | null;
  platformFee: number | null;
  commissionBps: number | null;
  etaMin: number | null;
  etaMax: number | null;
  pureVeg: boolean;
  payoutConfigured: boolean;
  payoutBankAccountHolderName: string;
  payoutBankAccountNumber: string;
  payoutBankIfsc: string;
  payoutBankName: string;
  payoutAccountType: string;
  payoutUpiId: string;
  payoutPanNumber: string;
  updatedAt: number | null;
}

export interface AdminAccountExportRow {
  uid: string;
  email: string;
  displayName: string;
  role: string;
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function str(value: unknown, max = 500): string {
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
  return "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function objectSize(value: unknown): number {
  return value !== null && typeof value === "object" ? Object.keys(value as object).length : 0;
}

/**
 * `feastly/users/{uid}/addresses` is a client-persisted array, which Realtime
 * Database stores as an object keyed by stringified index - never assume the
 * keys are the address ids themselves.
 */
function addressList(value: unknown): Record<string, unknown>[] {
  return Object.values(record(value)).map(record);
}

export function customerExportRows(users: Record<string, unknown> | null | undefined): CustomerExportRow[] {
  return Object.entries(users ?? {}).map(([uid, raw]) => {
    const data = record(raw);
    const addresses = addressList(data.addresses);
    const selectedId = str(data.selectedAddressId);
    const primary = (selectedId && addresses.find((entry) => str(entry.id) === selectedId)) || addresses[0] || {};
    const preferences = record(data.preferences);
    return {
      uid,
      name: str(data.name, 120),
      email: str(data.email, 254),
      emailVerified: bool(data.emailVerified),
      phone: str(data.phone, 24),
      addressCount: addresses.length,
      primaryAddress: str(primary.address || primary.details, 300),
      area: str(primary.area, 120),
      city: str(primary.city, 120),
      favouritesCount: objectSize(data.favourites),
      themePreference: str(preferences.theme, 20) || "system",
      notificationsEnabled: preferences.notifications !== false,
      vegetarianPreference: bool(preferences.vegetarian),
      updatedAt: num(data.updatedAt),
    };
  });
}

export function riderExportRows(riders: Record<string, unknown> | null | undefined): RiderExportRow[] {
  return Object.entries(riders ?? {}).map(([uid, raw]) => {
    const data = record(raw);
    return {
      uid,
      fullName: str(data.fullName, 120),
      email: str(data.email, 254),
      phone: str(data.phone, 24),
      city: str(data.city, 120),
      address: str(data.address, 600),
      vehicleType: str(data.vehicleType, 40),
      vehicleNumber: str(data.vehicleNumber, 40),
      aadhaarLast4: str(data.aadhaarLast4, 4),
      panNumber: str(data.panNumber, 10),
      status: str(data.status, 40),
      documentsVerified: bool(data.documentsVerified),
      approvedAt: num(data.approvedAt),
      submittedAt: num(data.submittedAt),
      updatedAt: num(data.updatedAt),
    };
  });
}

/**
 * `payoutProfile` holds the restaurant's raw bank account number, IFSC and UPI
 * id - real payment credentials, included here on explicit owner request. The
 * owner-only claim gate and the formula-injection sanitiser applied when this
 * is written to the sheet (see addSheet below) both still apply to these
 * fields exactly as they do to every other one.
 */
export function restaurantExportRows(
  restaurants: Record<string, unknown> | null | undefined,
): RestaurantExportRow[] {
  return Object.entries(restaurants ?? {}).map(([restaurantId, raw]) => {
    const data = record(raw);
    const cuisines = Array.isArray(data.cuisines)
      ? data.cuisines.filter((entry): entry is string => typeof entry === "string").map((entry) => str(entry, 40))
      : [];
    const payout = record(data.payoutProfile);
    return {
      restaurantId,
      name: str(data.name, 160),
      phone: str(data.phone, 24),
      city: str(data.city, 120),
      category: str(data.category, 60),
      cuisines: cuisines.join(", "),
      address: str(data.address, 300),
      lat: num(data.lat),
      lng: num(data.lng),
      open: bool(data.open),
      active: data.active !== false,
      archived: bool(data.archived),
      rating: num(data.rating),
      ratingCount: num(data.ratingCount),
      deliveryFee: num(data.deliveryFee),
      platformFee: num(data.platformFee),
      commissionBps: num(data.commissionBps),
      etaMin: num(data.etaMin),
      etaMax: num(data.etaMax),
      pureVeg: bool(data.pureVeg),
      payoutConfigured: objectSize(payout) > 0,
      payoutBankAccountHolderName: str(payout.bankAccountHolderName, 160),
      payoutBankAccountNumber: str(payout.bankAccountNumber, 40),
      payoutBankIfsc: str(payout.bankIfsc, 20),
      payoutBankName: str(payout.bankName, 120),
      payoutAccountType: str(payout.accountType, 30),
      payoutUpiId: str(payout.upiId, 80),
      payoutPanNumber: str(payout.panNumber, 10),
      updatedAt: num(data.updatedAt),
    };
  });
}

export interface AdminAuthAccount {
  uid: string;
  email?: string;
  displayName?: string;
  disabled: boolean;
  customClaims?: Record<string, unknown>;
  metadata?: {creationTime?: string; lastSignInTime?: string};
}

export function adminAccountExportRows(
  users: readonly (AdminAuthAccount | UserRecord)[],
): AdminAccountExportRow[] {
  return users
    .map((user) => {
      const claims = record(user.customClaims);
      const role = claims.savrivoRole === "owner" || claims.savrivoRole === "ops_admin"
        ? String(claims.savrivoRole)
        : "";
      return {user, role};
    })
    .filter((entry): entry is {user: AdminAuthAccount | UserRecord; role: string} => entry.role !== "")
    .map(({user, role}) => ({
      uid: user.uid,
      email: str(user.email, 254),
      displayName: str(user.displayName, 160),
      role,
      disabled: !!user.disabled,
      createdAt: str(user.metadata?.creationTime, 60),
      lastSignInAt: str(user.metadata?.lastSignInTime, 60),
    }));
}

function normalizedCity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Admin accounts have no city at all - they are platform-wide, not tied to
 * one place - so a city filter only ever narrows the other three sheets.
 * Matching is case/whitespace-insensitive against whatever city value is
 * actually on the record, since that is exactly where the selectable list
 * the owner picks from comes from.
 */
export function filterRowsByCity<T extends {city: string}>(
  rows: readonly T[],
  city: string | null | undefined,
): T[] {
  const target = normalizedCity(String(city ?? ""));
  if (!target) return rows.slice();
  return rows.filter((row) => normalizedCity(row.city) === target);
}

// Spreadsheet applications can treat a cell that starts with one of these
// characters as a formula. Every free-text field in this export ultimately
// comes from something a user typed (a name, an address, a vehicle number),
// so it is sanitised uniformly rather than trusted per-field.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function sanitizeSpreadsheetText(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

interface ColumnDef<T> {
  header: string;
  key: string;
  width?: number;
  numFmt?: string;
  transform?: (row: T) => unknown;
}

function addSheet<T>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: readonly ColumnDef<T>[],
  rows: readonly T[],
): void {
  const sheet = workbook.addWorksheet(name, {views: [{state: "frozen", ySplit: 1}]});
  sheet.columns = columns.map((column) => ({header: column.header, key: column.key, width: column.width ?? 22}));
  sheet.getRow(1).font = {bold: true};
  rows.forEach((row) => {
    const values: Record<string, unknown> = {};
    columns.forEach((column) => {
      const raw = column.transform ? column.transform(row) : (row as Record<string, unknown>)[column.key];
      values[column.key] = typeof raw === "string" ? sanitizeSpreadsheetText(raw) : raw ?? "";
    });
    const added = sheet.addRow(values);
    columns.forEach((column, index) => {
      if (column.numFmt) added.getCell(index + 1).numFmt = column.numFmt;
    });
  });
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function dateOrBlank(value: number | null): unknown {
  return typeof value === "number" ? new Date(value) : "";
}

const DATE_NUM_FMT = "yyyy-mm-dd hh:mm";

export interface PlatformDataWorkbookInput {
  generatedAt: number;
  generatedByEmail: string;
  /** Empty string (or omitted) means every city - shown in the Export Info sheet as "All cities". */
  cityFilter?: string;
  customers: readonly CustomerExportRow[];
  riders: readonly RiderExportRow[];
  restaurants: readonly RestaurantExportRow[];
  adminAccounts: readonly AdminAccountExportRow[];
}

export async function buildPlatformDataWorkbookBuffer(input: PlatformDataWorkbookInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Savrivo Admin";
  workbook.created = new Date(input.generatedAt);

  addSheet<CustomerExportRow>(workbook, "Customers", [
    {header: "UID", key: "uid", width: 30},
    {header: "Name", key: "name"},
    {header: "Email", key: "email", width: 28},
    {header: "Email Verified", key: "emailVerified", width: 14, transform: (r) => yesNo(r.emailVerified)},
    {header: "Phone", key: "phone", width: 16},
    {header: "Saved Addresses", key: "addressCount", width: 14},
    {header: "Primary Address", key: "primaryAddress", width: 36},
    {header: "Area", key: "area"},
    {header: "City", key: "city"},
    {header: "Favourites", key: "favouritesCount", width: 12},
    {header: "Theme", key: "themePreference", width: 12},
    {header: "Notifications On", key: "notificationsEnabled", width: 15, transform: (r) => yesNo(r.notificationsEnabled)},
    {header: "Vegetarian Only", key: "vegetarianPreference", width: 15, transform: (r) => yesNo(r.vegetarianPreference)},
    {header: "Last Updated", key: "updatedAt", width: 20, numFmt: DATE_NUM_FMT, transform: (r) => dateOrBlank(r.updatedAt)},
  ], input.customers);

  addSheet<RiderExportRow>(workbook, "Riders", [
    {header: "UID", key: "uid", width: 30},
    {header: "Full Name", key: "fullName"},
    {header: "Email", key: "email", width: 28},
    {header: "Phone", key: "phone", width: 16},
    {header: "City", key: "city"},
    {header: "Address", key: "address", width: 36},
    {header: "Vehicle Type", key: "vehicleType", width: 14},
    {header: "Vehicle Number", key: "vehicleNumber", width: 16},
    {header: "Aadhaar (Last 4)", key: "aadhaarLast4", width: 14},
    {header: "PAN Number", key: "panNumber", width: 14},
    {header: "Status", key: "status", width: 14},
    {header: "Documents Verified", key: "documentsVerified", width: 16, transform: (r) => yesNo(r.documentsVerified)},
    {header: "Approved At", key: "approvedAt", width: 20, numFmt: DATE_NUM_FMT, transform: (r) => dateOrBlank(r.approvedAt)},
    {header: "Submitted At", key: "submittedAt", width: 20, numFmt: DATE_NUM_FMT, transform: (r) => dateOrBlank(r.submittedAt)},
    {header: "Last Updated", key: "updatedAt", width: 20, numFmt: DATE_NUM_FMT, transform: (r) => dateOrBlank(r.updatedAt)},
  ], input.riders);

  addSheet<RestaurantExportRow>(workbook, "Restaurants", [
    {header: "Restaurant ID", key: "restaurantId", width: 28},
    {header: "Name", key: "name", width: 24},
    {header: "Phone", key: "phone", width: 16},
    {header: "City", key: "city"},
    {header: "Category", key: "category", width: 14},
    {header: "Cuisines", key: "cuisines", width: 28},
    {header: "Address", key: "address", width: 36},
    {header: "Latitude", key: "lat", width: 12},
    {header: "Longitude", key: "lng", width: 12},
    {header: "Open Now", key: "open", width: 12, transform: (r) => yesNo(r.open)},
    {header: "Active", key: "active", width: 10, transform: (r) => yesNo(r.active)},
    {header: "Archived", key: "archived", width: 12, transform: (r) => yesNo(r.archived)},
    {header: "Rating", key: "rating", width: 10},
    {header: "Rating Count", key: "ratingCount", width: 13},
    {header: "Delivery Fee", key: "deliveryFee", width: 13},
    {header: "Platform Fee", key: "platformFee", width: 13},
    {header: "Commission (bps)", key: "commissionBps", width: 16},
    {header: "ETA Min", key: "etaMin", width: 10},
    {header: "ETA Max", key: "etaMax", width: 10},
    {header: "Pure Veg", key: "pureVeg", width: 10, transform: (r) => yesNo(r.pureVeg)},
    {header: "Payout Configured", key: "payoutConfigured", width: 17, transform: (r) => yesNo(r.payoutConfigured)},
    {header: "Bank Account Holder", key: "payoutBankAccountHolderName", width: 24},
    {header: "Bank Account Number", key: "payoutBankAccountNumber", width: 20},
    {header: "Bank IFSC", key: "payoutBankIfsc", width: 14},
    {header: "Bank Name", key: "payoutBankName", width: 20},
    {header: "Account Type", key: "payoutAccountType", width: 14},
    {header: "UPI ID", key: "payoutUpiId", width: 22},
    {header: "Payout PAN Number", key: "payoutPanNumber", width: 16},
    {header: "Last Updated", key: "updatedAt", width: 20, numFmt: DATE_NUM_FMT, transform: (r) => dateOrBlank(r.updatedAt)},
  ], input.restaurants);

  addSheet<AdminAccountExportRow>(workbook, "Admin Accounts", [
    {header: "UID", key: "uid", width: 30},
    {header: "Email", key: "email", width: 28},
    {header: "Display Name", key: "displayName", width: 22},
    {header: "Role", key: "role", width: 14},
    {header: "Disabled", key: "disabled", width: 12, transform: (r) => yesNo(r.disabled)},
    {header: "Created At", key: "createdAt", width: 26},
    {header: "Last Sign-in At", key: "lastSignInAt", width: 26},
  ], input.adminAccounts);

  const infoSheet = workbook.addWorksheet("Export Info");
  infoSheet.columns = [{header: "Field", key: "field", width: 20}, {header: "Value", key: "value", width: 70}];
  infoSheet.getRow(1).font = {bold: true};
  const info: [string, string][] = [
    ["Generated At", new Date(input.generatedAt).toISOString()],
    ["Generated By", input.generatedByEmail],
    ["City Filter", input.cityFilter && input.cityFilter.trim() ? input.cityFilter.trim() : "All cities"],
    ["Customers", String(input.customers.length)],
    ["Riders", String(input.riders.length)],
    ["Restaurants", String(input.restaurants.length)],
    ["Admin Accounts", String(input.adminAccounts.length) + " (not city-scoped)"],
    ["Note", "This export includes restaurant bank account numbers, IFSC codes, UPI ids and PAN numbers "
      + "on the Restaurants sheet. Handle, store and delete this file securely; it is not for general sharing."],
  ];
  info.forEach(([field, value]) => infoSheet.addRow({field, value: sanitizeSpreadsheetText(value)}));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
