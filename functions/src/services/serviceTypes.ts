import type {z} from "zod";
import {
  claimOrderSchema,
  clusterOrderSchema,
  clusterPreviewSchema,
  createOrderSchema,
  createCodOrderSchema,
  initiatePaymentSchema,
  registerDeviceTokenSchema,
  transitionOrderSchema,
  unregisterDeviceTokenSchema,
} from "../schemas";

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type CreateCodOrderInput = z.infer<typeof createCodOrderSchema>;
export type TransitionOrderInput = z.infer<typeof transitionOrderSchema>;
export type ClaimOrderInput = z.infer<typeof claimOrderSchema>;
export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;
export type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>;
export type UnregisterDeviceTokenInput = z.infer<typeof unregisterDeviceTokenSchema>;
export type ClusterPreviewInput = z.infer<typeof clusterPreviewSchema>;
export type ClusterOrderInput = z.infer<typeof clusterOrderSchema>;
