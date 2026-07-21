import { fM, fN } from "@/lib/format";
import {
  getAtcCount,
  getCostPerAtc,
  getCostPerLinkClick,
  getCostPerPurchase,
  getLinkClicks,
  getPurchaseCount,
  getRoas,
} from "@/lib/insights";
import type { FbBaseEntity } from "@/types/fb";
import { spendPlus } from "@/views/finance/financeData";
import { Fragment } from "react";
import type { TreeColKey } from "./treeCols";

/**
 * 花費+% cell — spend × (1 + markup/100), orange + bold. Rendered
 * immediately after the 花費 column (out-of-band from the trailing
 * extras) because it needs the campaign markup %. Renders nothing when
 * the column isn't enabled so header/body column counts stay aligned.
 */
export function SpendPlusCell({
  show,
  spend,
  markupPercent,
}: {
  show: boolean;
  spend: number;
  markupPercent: number;
}) {
  if (!show) return null;
  // NOTE: use `tabular-nums`, NOT the `.num` class — `.num` hardcodes
  // `color: var(--black)` in the same @layer utilities, which has equal
  // specificity to `text-orange` and (being later in source order) wins,
  // so `.num text-orange` renders BLACK. `tabular-nums` gives the same
  // numeral alignment without fighting the colour.
  return (
    <td className="tabular-nums font-bold text-orange">
      {`$${fM(spendPlus(spend, markupPercent))}`}
    </td>
  );
}

/**
 * Render the optionally-visible e-commerce KPI cells in the order
 * defined by `extras`. Returns one `<td className="num">` per enabled
 * code; "—" for empty values to match the existing 私訊數 / 私訊成本
 * convention so blanks read consistently.
 */
export function ExtraTreeCells({
  entity,
  extras,
}: {
  entity: FbBaseEntity;
  extras: string[];
}) {
  return (
    <>
      {extras.map((code) => (
        <Fragment key={code}>{renderCell(code as TreeColKey, entity)}</Fragment>
      ))}
    </>
  );
}

function renderCell(code: TreeColKey, entity: FbBaseEntity) {
  switch (code) {
    // Rendered separately right after 花費 (see SpendPlusCell) — skip
    // here so it isn't duplicated in the trailing extras block.
    case "spend_plus":
      return null;
    case "link_clicks": {
      const v = getLinkClicks(entity);
      return <td className="num">{v > 0 ? fN(v) : "—"}</td>;
    }
    case "cost_per_link_click": {
      const v = getCostPerLinkClick(entity);
      return <td className="num">{v > 0 ? `$${fM(v)}` : "—"}</td>;
    }
    case "add_to_cart": {
      const v = getAtcCount(entity);
      return <td className="num">{v > 0 ? fN(v) : "—"}</td>;
    }
    case "cost_per_add_to_cart": {
      const v = getCostPerAtc(entity);
      return <td className="num">{v > 0 ? `$${fM(v)}` : "—"}</td>;
    }
    case "purchases": {
      const v = getPurchaseCount(entity);
      return <td className="num">{v > 0 ? fN(v) : "—"}</td>;
    }
    case "cost_per_purchase": {
      const v = getCostPerPurchase(entity);
      return <td className="num">{v > 0 ? `$${fM(v)}` : "—"}</td>;
    }
    case "roas": {
      const v = getRoas(entity);
      return <td className="num">{v > 0 ? v.toFixed(2) : "—"}</td>;
    }
    default:
      return <td className="num">—</td>;
  }
}
