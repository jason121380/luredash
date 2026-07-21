import {
  type EInvoiceDraft,
  type InvoiceBuyer,
  type InvoiceBuyerInput,
  type IssueInvoiceInput,
  api,
} from "@/api/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * 電子發票 (ezPay) hooks — Phase 1 covers buyer-profile CRUD only. The
 * buyer list is admin-gated server-side; a non-admin session gets a 403
 * which surfaces as the query error (the page itself is already hidden
 * from non-admins via 頁面權限, so this is defence-in-depth).
 */

const BUYERS_KEY = ["invoice-buyers"] as const;

export function useInvoiceBuyers() {
  return useQuery({
    queryKey: BUYERS_KEY,
    queryFn: async (): Promise<InvoiceBuyer[]> => {
      const { data } = await api.einvoice.listBuyers();
      return data;
    },
    staleTime: 60_000,
  });
}

export function useUpsertInvoiceBuyer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ store, body }: { store: string; body: InvoiceBuyerInput }) =>
      api.einvoice.upsertBuyer(store, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BUYERS_KEY });
    },
  });
}

export function useDeleteInvoiceBuyer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (store: string) => api.einvoice.removeBuyer(store),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BUYERS_KEY });
    },
  });
}

export function useIssueInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueInvoiceInput) => api.einvoice.issue(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["einvoices"] });
    },
  });
}

export function useEInvoices(params?: { store?: string; status?: string; period?: string }) {
  return useQuery({
    queryKey: ["einvoices", params ?? {}],
    queryFn: () => api.einvoice.list(params),
    staleTime: 30_000,
  });
}

export function useDeleteEInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.einvoice.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["einvoices"] });
    },
  });
}

const DRAFTS_KEY = ["einvoice-drafts"] as const;

export function useEInvoiceDrafts() {
  return useQuery({
    queryKey: DRAFTS_KEY,
    queryFn: () => api.einvoice.drafts(),
    staleTime: 5 * 60_000,
  });
}

export function useSaveEInvoiceDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, body }: { campaignId: string; body: EInvoiceDraft }) =>
      api.einvoice.saveDraft(campaignId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DRAFTS_KEY });
    },
  });
}
