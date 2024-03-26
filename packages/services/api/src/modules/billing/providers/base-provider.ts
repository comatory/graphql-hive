import { BillingInvoiceStatus } from '../../../__generated__/types';

type Cents = number;

export type BillingPrices = {
  basePrice: { identifier: string; amount: Cents };
  pricePerMillionOperations: { identifier: string; amount: Cents };
};

export type BillingInvoice = {
  id: string | null;
  amount: Cents;
  date: Date;
  periodStart: Date;
  periodEnd: Date;
  pdfUrl: string | null;
  status: BillingInvoiceStatus;
};

export type Subscription = {
  id: string;
  trialEnd: number | null;
};

export type BillingInfo = {
  taxId: string | null;
  legalName: string | null;
  billingEmail: string | null;
  paymentMethod: null | {
    type: string;
    brand: string | null;
    last4: string | null;
  };
};

export type BillingInfoUpdateInput = Omit<BillingInfo, 'paymentMethod'>;

export interface BillingDataProvider {
  getAvailablePrices(): Promise<BillingPrices>;
  invoices(customerId: string): Promise<BillingInvoice[]>;
  upcomingInvoice(customerId: string): Promise<BillingInvoice | null>;
  getActiveSubscription(customerId: string): Promise<Subscription | null>;
  hasPaymentIssues(customerId: string): Promise<boolean>;
  subscriptionManagementUrl(customerId: string): Promise<string | null>;
  syncOperationsLimit(customerId: string, operationsInMillions: number): Promise<void>;
  cancelActiveSubscription(customerId: string): Promise<void>;
  billingInfo(customerId: string): Promise<BillingInfo>;
}
