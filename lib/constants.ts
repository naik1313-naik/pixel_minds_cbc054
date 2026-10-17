export {
  CUSTOMER_LOCATION,
  haversineKm,
  roadDistanceKm,
  etaMinutes,
  interpolate,
  headingDeg,
} from "./geo";

export const WHOLESALE_RATE = 0.85;
export const PLATFORM_FEE_RATE = 0.05;

/**
 * What the customer pays to have the medicine delivered.
 *
 * Charged on top of the medicine price and paid to the rider, not the pharmacy.
 * The platform fee is computed on the medicine amount only, so taking 5% of a
 * delivery fee would be money taken out of the rider's pay for no service
 * rendered.
 */
export const DELIVERY_FEE_PAISE = 2500;

// Serviceable delivery radius from the fulfilling pharmacy.
export const DELIVERY_RADIUS_KM = 8;
export const GEOFENCE_METERS = 150;

export const REQUEST_STATUS = {
  REQUESTED: "Requested",
  SOURCING: "Sourcing",
  NEEDS_VERIFICATION: "NeedsVerification",
  CONFIRMED: "Confirmed",
  READY: "Ready",
  COMPLETED: "Completed",
  PARTIAL: "PartialOffer",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  UNAVAILABLE: "Unavailable",
  CANCELLED: "Cancelled",
} as const;

export const DELIVERY_STATUS = {
  SEARCHING: "SearchingPartner",
  AWAITING_PHARMACY_APPROVAL: "AwaitingPharmacyApproval",
  ASSIGNED: "Assigned",
  ARRIVED_PHARMACY: "ArrivedAtPharmacy",
  PICKED_UP: "PickedUp",
  OUT_FOR_DELIVERY: "OutForDelivery",
  ARRIVED_DESTINATION: "ArrivedAtDestination",
  DELIVERED: "Delivered",
  CUSTOMER_UNREACHABLE: "CustomerUnreachable",
  HANDOVER_FAILED: "HandoverFailed",
  RETURNED: "ReturnedToPharmacy",
  CANCELLED: "Cancelled",
} as const;

// Legal delivery transitions (server-authoritative state machine).
export const DELIVERY_TRANSITIONS: Record<string, string[]> = {
  SearchingPartner: ["AwaitingPharmacyApproval", "Assigned", "Cancelled"],
  AwaitingPharmacyApproval: ["Assigned", "SearchingPartner", "Cancelled"],
  Assigned: ["ArrivedAtPharmacy", "Cancelled", "CustomerUnreachable", "ReturnedToPharmacy"],
  ArrivedAtPharmacy: ["PickedUp", "Cancelled", "CustomerUnreachable", "ReturnedToPharmacy"],
  PickedUp: ["OutForDelivery", "Cancelled", "CustomerUnreachable", "ReturnedToPharmacy"],
  OutForDelivery: ["ArrivedAtDestination", "CustomerUnreachable", "ReturnedToPharmacy", "Cancelled"],
  ArrivedAtDestination: ["Delivered", "HandoverFailed", "CustomerUnreachable", "ReturnedToPharmacy"],
  Delivered: [],
  CustomerUnreachable: ["ReturnedToPharmacy"],
  HandoverFailed: ["ReturnedToPharmacy"],
  ReturnedToPharmacy: ["Cancelled"],
  Cancelled: [],
};

export const ACTIVE_DELIVERY_STATUSES = [
  DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL,
  DELIVERY_STATUS.ASSIGNED,
  DELIVERY_STATUS.ARRIVED_PHARMACY,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.OUT_FOR_DELIVERY,
  DELIVERY_STATUS.ARRIVED_DESTINATION,
];

// location accepted only during these states
export const TRACKABLE_DELIVERY_STATUSES = [
  DELIVERY_STATUS.ASSIGNED,
  DELIVERY_STATUS.ARRIVED_PHARMACY,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.OUT_FOR_DELIVERY,
  DELIVERY_STATUS.ARRIVED_DESTINATION,
];

export const ROLES = ["customer", "pharmacy_owner", "pharmacy_staff", "delivery_partner", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function depositPaiseFromRupees(r: number): number {
  return Math.round(r * 100);
}
