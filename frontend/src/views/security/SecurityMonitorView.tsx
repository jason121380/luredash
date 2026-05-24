import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { AcctSidebarToggle } from "@/components/AcctSidebarToggle";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { MobileAccountPicker } from "@/components/MobileAccountPicker";
import { Topbar, TopbarSeparator } from "@/layout/Topbar";
import type { DateConfig } from "@/lib/datePicker";
import { useAccountsStore } from "@/stores/accountsStore";
import { useUiStore } from "@/stores/uiStore";
import { useMemo, useState } from "react";
import { AlertAccountPanel } from "../alerts/AlertAccountPanel";
import { SecurityCampaignRow } from "./SecurityCampaignRow";
import { buildSecurityDays, formatDayLabel, resolveBounds } from "./securityData";

/**
 * 安全監控 — surfaces newly-created campaigns grouped by day so the
 * operator can scan for unusual creations (deep-night / weekend /
 * burst). Reuses the 240px account panel from Alerts and the standard
 * Topbar + DatePicker.
 *
 * The DatePicker state is LOCAL (not the shared `filtersStore.date`)
 * because this view interprets the range as "campaigns created in this
 * window", not "insights for this window" — and defaults to last 7
 * days rather than 30. Keeping it local avoids mutating the shared
 * preset for other views when the user opens 安全監控.
 */
export function SecurityMonitorView() {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visibleAll = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const selectedAcctId = useUiStore((s) => s.alertSelectedAcctId);
  const setSelectedAcctId = useUiStore((s) => s.setAlertSelectedAcctId);
  const settingsReady = useUiStore((s) => s.settingsReady);

  const [date, setDate] = useState<DateConfig>({
    preset: "last_7d",
    from: null,
    to: null,
  });

  // Reuse the overview batch endpoint. We only care about the campaign
  // metadata (lite phase already gives us name / status / created_time /
  // budget / objective). insightsPending is ignored — we never read
  // insights here.
  const overview = useMultiAccountOverview(visibleAll, date, { includeArchived: true });

  const scopedCampaigns = useMemo(() => {
    if (selectedAcctId === null) return overview.campaigns;
    return overview.campaigns.filter((c) => c._accountId === selectedAcctId);
  }, [overview.campaigns, selectedAcctId]);

  const days = useMemo(() => buildSecurityDays(scopedCampaigns, date), [scopedCampaigns, date]);

  // Convert the date range to unix seconds once — shared by every row's
  // activities query so they all hit the same React Query cache entry.
  const activitiesBounds = useMemo(() => {
    const { from, to } = resolveBounds(date);
    return { since: Math.floor(from / 1000), until: Math.floor(to / 1000) };
  }, [date]);

  return (
    <>
      <Topbar title="安全監控" titleAction={<AcctSidebarToggle />}>
        <div className="flex items-center gap-2 md:gap-3">
          <MobileAccountPicker
            accounts={visibleAll}
            selectedId={selectedAcctId}
            onSelect={setSelectedAcctId}
            className="bg-transparent px-0 py-0"
          />
          <TopbarSeparator />
          <DatePicker value={date} onChange={setDate} />
        </div>
      </Topbar>

      <div className="flex min-w-0 items-start md:flex-row">
        {/* Desktop sidebar (≥768px) */}
        <div className="hidden md:flex">
          <AlertAccountPanel
            accounts={visibleAll}
            selectedAccountId={selectedAcctId}
            onSelect={setSelectedAcctId}
          />
        </div>

        <div className="min-w-0 flex-1 p-3 md:p-5">
          {!settingsReady ? (
            <LoadingState
              title="載入廣告資料中..."
              loaded={overview.loadedCount}
              total={overview.totalCount}
            />
          ) : visibleAll.length === 0 ? (
            <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
          ) : overview.isLoading ? (
            <LoadingState
              title="載入廣告資料中..."
              loaded={overview.loadedCount}
              total={overview.totalCount}
            />
          ) : days.length === 0 ? (
            <EmptyState>所選日期區間內沒有新建立的行銷活動</EmptyState>
          ) : (
            <SecurityDayList
              days={days}
              activitiesSince={activitiesBounds.since}
              activitiesUntil={activitiesBounds.until}
            />
          )}
        </div>
      </div>
    </>
  );
}

interface SecurityDayListProps {
  days: ReturnType<typeof buildSecurityDays>;
  activitiesSince: number;
  activitiesUntil: number;
}

function SecurityDayList({ days, activitiesSince, activitiesUntil }: SecurityDayListProps) {
  return (
    <div className="flex flex-col gap-4">
      {days.map((day) => (
        <section key={day.dateKey} className="flex flex-col gap-2">
          <header className="flex items-baseline gap-2 px-1">
            <h2 className="text-[14px] font-semibold text-ink">{formatDayLabel(day.dateKey)}</h2>
            <span className="text-[11px] text-gray-500">共 {day.rows.length} 個新活動</span>
          </header>
          <div className="flex flex-col gap-2">
            {day.rows.map((row) => (
              <SecurityCampaignRow
                key={row.campaign.id}
                row={row}
                activitiesSince={activitiesSince}
                activitiesUntil={activitiesUntil}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
