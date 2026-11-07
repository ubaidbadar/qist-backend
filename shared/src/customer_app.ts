import { z } from 'zod';
import { objectIdSchema, passwordSchema } from './fields';
import { mobileSchema } from './identifiers';
import type { ContractStatus, Frequency, InstallmentStatus, PaymentMethod } from './constants';
import type { RetailerPaymentMethod } from './org';
import type { Page } from './api';

export const customerLoginSchema = z.object({ phone: mobileSchema, password: passwordSchema });
export const customerRecoverySchema = z.object({ phone: mobileSchema });
export const customerVerifyCodeSchema = customerRecoverySchema.extend({ code: z.string().regex(/^\d{6}$/, 'Enter the six-digit WhatsApp code') });
export const customerSetPasswordSchema = customerLoginSchema.extend({ setupToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Verify your WhatsApp code again') });
export interface CustomerAppConfig { maintenance: boolean }
export interface CustomerAuthStart { next: 'password' | 'otp' | 'unregistered'; retryAfterSeconds?: number }
export interface CustomerSetupProof { setupToken: string; expiresAt: string }
export const customerResetSchema = customerLoginSchema.extend({ code: z.string().regex(/^\d{6}$/, 'Enter the six-digit WhatsApp code') });
export const customerOverviewQuerySchema = z.object({ contractId: objectIdSchema.optional() });
export const customerPaymentsQuerySchema = z.object({ contractId: objectIdSchema, cursor: objectIdSchema.optional() });

export interface CustomerAppSession { accessToken: string; expiresAt: string }
export interface CustomerAppContractChoice { id: string; deviceLabel: string; retailer: string; status: ContractStatus; nextDueDate?: string | null; nextAmount?: number; count?: number; completedOn?: string | null }
export interface CustomerAppInstallment {
  number: number; dueDate: string; amount: number; lateFee: number; paidAmount: number; status: InstallmentStatus;
}
export interface CustomerAppPayment {
  id: string; receiptNumber: number; amount: number; method: PaymentMethod; receivedOn: string;
  receivedByName: string; kind: 'down_payment' | 'installment'; reference: string;
  allocations: { number: number; amount: number }[];
}
export interface CustomerAppContract extends CustomerAppContractChoice {
  downPayment: number; totalPayable: number; paidTotal: number; lateFees: number; count: number; frequency: Frequency;
  retailerPhone: string; retailerAddress: string; deviceLockState: 'locked' | 'unlocked' | null;
  paymentMethods: RetailerPaymentMethod[];
  installments: CustomerAppInstallment[];
}
/** Money is integer paisa. Dates are Pakistan calendar dates, not device-local timestamps. */
export interface CustomerAppNotification { id: string; contractId: string; kind: string; title: string; body: string; createdAt: string; read: boolean }
export interface CustomerAppOverview {
  notifications: CustomerAppNotification[];
  profile: { name: string; phone: string; retailer?: string; retailerPhone?: string };
  contracts: CustomerAppContractChoice[];
  contract: CustomerAppContract | null;
  payments: Page<CustomerAppPayment>;
  today: string;
}

export const customerPushSchema = z.object({ token: z.string().min(20).max(4096).regex(/^[A-Za-z0-9_:.-]+$/) });
export const customerReadNotificationsSchema = z.object({ ids: z.array(objectIdSchema).min(1).max(30) });
