// NamastePOS customer dashboard — guest API client
// PUBLIC endpoints (no auth header). Uses a fresh axios instance to keep
// the JWT-injecting interceptors from leaking into guest requests.

import axios from 'axios';

const baseURL = (() => {
  const env = (import.meta.env.VITE_API_URL || '/v1') as string;
  return env.endsWith('/v1') ? env : `${env}/v1`;
})();

const guestApi = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
});

export interface GuestMenu {
  business: { name: string; logoUrl?: string };
  table: { label: string; floor?: string };
  settings: {
    isEnabled: boolean;
    welcomeTitle: string;
    welcomeSubtitle: string;
    brandColor: string;
    requirePhone: boolean;
    requireName: boolean;
    showPrices: boolean;
    showVegBadge: boolean;
  };
  items: Array<{
    id: string; name: string; description?: string; category: string;
    price: number; unit: string; isVeg: boolean; imageUrl?: string;
  }>;
}

export const guest = {
  menu: (token: string) =>
    guestApi.get<GuestMenu>(`/guest/menu/${token}`).then((r) => r.data),

  placeOrder: (token: string, body: any) =>
    guestApi.post<{ order: { id: string; orderNo: number; total: number }; message: string }>(
      `/guest/orders/${token}`, body
    ).then((r) => r.data),

  orderStatus: (token: string, orderId: string) =>
    guestApi.get(`/guest/orders/${token}/${orderId}`).then((r) => r.data),

  // Guest membership-benefit OTP gate. Call before placing an order when a
  // phone is entered: if the phone owns a membership benefit, the server
  // sends an OTP and returns { otpRequired:true, requestId }. Verify returns
  // a benefitToken to attach to placeOrder so the benefit is honored.
  benefitCheck: (token: string, phone: string) =>
    guestApi.post<{ otpRequired: boolean; requestId?: string }>(
      `/guest/benefit/check/${token}`, { phone }
    ).then((r) => r.data),
  benefitVerify: (token: string, body: { requestId: string; code: string; phone: string }) =>
    guestApi.post<{ benefitToken: string }>(
      `/guest/benefit/verify/${token}`, body
    ).then((r) => r.data),

  // FF-251 — running session bill + pay-all-in-one from same QR
  currentSession: (token: string) =>
    guestApi.get<{ session: any | null }>(`/guest/session/${token}/current`)
      .then((r) => r.data.session),
  paySession: (token: string) =>
    guestApi.post<{ razorpayOrderId: string; keyId: string; amount: number; sessionId: string }>(
      `/guest/session/${token}/pay`
    ).then((r) => r.data),
  confirmSessionPayment: (token: string, body: {
    sessionId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) =>
    guestApi.post(`/guest/session/${token}/confirm-pay`, body).then((r) => r.data),
};
