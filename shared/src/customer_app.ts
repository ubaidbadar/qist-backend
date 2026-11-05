import { z } from 'zod';
import { objectIdSchema, passwordSchema } from './fields';
import { mobileSchema } from './identifiers';
import type { ContractStatus, Frequency, InstallmentStatus, PaymentMethod } from './constants';
import type { Page } from './api';

export const customerLoginSchema = z.object({ phone: mobileSchema, password: passwordSchema });
export const customerRecoverySchema = z.object({ phone: mobileSchema });
export const customerResetSchema = customerLoginSchema.extend({ code: z.string().regex(/^\d{6}$/, 'Enter the six-digit WhatsApp code') });
export const customerOverviewQuerySchema = z.object({ contractId: objectIdSchema.optional() });
export const customerPaymentsQuerySchema = z.object({ contractId: objectIdSchema, cursor: objectIdSchema.optional() });

export interface CustomerAppSession { accessToken: string; expiresAt: string }
export interface CustomerAppContractChoice { id: string; deviceLabel: string; retailer: string; status: ContractStatus }
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
  installments: CustomerAppInstallment[];
}
/** Money is integer paisa. Dates are Pakistan calendar dates, not device-local timestamps. */
export interface CustomerAppOverview {
  profile: { name: string; phone: string };
  contracts: CustomerAppContractChoice[];
  contract: CustomerAppContract | null;
  payments: Page<CustomerAppPayment>;
  today: string;
}
