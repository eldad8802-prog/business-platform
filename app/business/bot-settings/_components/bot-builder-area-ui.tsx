import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";

export const BUILDER_SHELL_MAX_WIDTH = 560;

export function AreaHeader({
  title,
  subtitle,
  backHref,
  backLabel = "חזרה",
}: {
  title: string;
  subtitle?: string;
  backHref: string;
  backLabel?: string;
}) {
  return (
    <header style={{ padding: "14px 18px 8px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "42px 1fr 42px",
          alignItems: "center",
          gap: 10,
          minHeight: 42,
        }}
      >
        <Link
          href={backHref}
          aria-label={backLabel}
          style={{
            width: 42,
            height: 42,
            borderRadius: TOKEN.radius.pill,
            background: TOKEN.surface.inset,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            color: TOKEN.ink.primary,
            display: "grid",
            placeItems: "center",
            textDecoration: "none",
            fontSize: TOKEN.font.display,
            lineHeight: 1,
            boxSizing: "border-box",
          }}
        >
          ›
        </Link>
        <div
          style={{
            textAlign: "center",
            color: TOKEN.ink.primary,
            fontSize: TOKEN.font.title,
            fontWeight: TOKEN.weight.bold,
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        <div aria-hidden />
      </div>
      {subtitle ? (
        <p
          style={{
            margin: "12px 0 0",
            color: TOKEN.ink.muted,
            fontSize: TOKEN.font.body,
            lineHeight: 1.55,
            fontWeight: TOKEN.weight.medium,
          }}
        >
          {subtitle}
        </p>
      ) : null}
    </header>
  );
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 52px",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: TOKEN.ink.primary,
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.semibold,
            lineHeight: 1.4,
          }}
        >
          {label}
        </div>
        {hint ? (
          <div
            style={{
              marginTop: 3,
              color: TOKEN.ink.muted,
              fontSize: TOKEN.font.meta,
              lineHeight: 1.45,
            }}
          >
            {hint}
          </div>
        ) : null}
        {children ? <div style={{ marginTop: 10 }}>{children}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: 52,
          height: 30,
          border: 0,
          borderRadius: TOKEN.radius.pill,
          background: checked ? TOKEN.action.primary.background : TOKEN.surface.inset,
          boxShadow: checked ? TOKEN.action.primary.shadowSoft : TOKEN.shadow.none,
          padding: 3,
          cursor: "pointer",
          justifySelf: "end",
          position: "relative",
        }}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 3,
            right: checked ? 25 : 3,
            width: 24,
            height: 24,
            borderRadius: TOKEN.radius.pill,
            background: TOKEN.surface.card,
            boxShadow: TOKEN.shadow.elevated,
            transition: "right 160ms ease",
          }}
        />
      </button>
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label?: string;
  onChange: (value: number) => void;
}) {
  const minusDisabled = value <= min;
  const plusDisabled = value >= max;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <StepButton
        label="הפחת"
        disabled={minusDisabled}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </StepButton>
      <div
        style={{
          minWidth: 64,
          height: 38,
          borderRadius: TOKEN.radius.input,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.card,
          display: "grid",
          placeItems: "center",
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.bold,
          boxSizing: "border-box",
        }}
      >
        {value}
      </div>
      <StepButton
        label="הוסף"
        disabled={plusDisabled}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </StepButton>
      {label ? (
        <span style={{ color: TOKEN.ink.secondary, fontSize: TOKEN.font.meta }}>
          {label}
        </span>
      ) : null}
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 38,
        height: 38,
        borderRadius: TOKEN.radius.input,
        border: `1px solid ${disabled ? TOKEN.border.DEFAULT : TOKEN.border.hover}`,
        background: disabled ? TOKEN.surface.inset : TOKEN.surface.card,
        color: disabled ? TOKEN.ink.meta : TOKEN.ink.primary,
        fontSize: TOKEN.font.title,
        fontWeight: TOKEN.weight.bold,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function GuardNote({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "attention" | "urgent" }) {
  const semanticTone = TOKEN.semantic[tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        margin: "18px 18px 0",
        padding: "11px 14px",
        background: semanticTone.bgSoft,
        borderRadius: TOKEN.radius.input,
        color: semanticTone.ink,
        fontSize: TOKEN.font.meta,
        fontWeight: TOKEN.weight.semibold,
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden style={{ color: semanticTone.accent, flexShrink: 0 }}>◇</span>
      <span>{children}</span>
    </div>
  );
}
export function StickyActionBar({
  onSave,
  saving,
  saved,
  error,
  saveLabel = "שמור",
}: {
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
  saveLabel?: string;
}) {
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        marginTop: 22,
        padding: "13px 18px 26px",
        background: TOKEN.surface.card,
        borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
        boxShadow: TOKEN.shadow.elevated,
        zIndex: 4,
      }}
    >
      {error ? (
        <div
          role="alert"
          style={{
            marginBottom: 10,
            background: TOKEN.semantic.urgent.bgSoft,
            color: TOKEN.semantic.urgent.ink,
            padding: "10px 12px",
            borderRadius: TOKEN.radius.input,
            fontSize: TOKEN.font.meta,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      ) : null}
      {saved ? (
        <div
          style={{
            marginBottom: 10,
            color: TOKEN.semantic.success.ink,
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.semibold,
          }}
        >
          נשמר
        </div>
      ) : null}
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        style={{
          width: "100%",
          minHeight: 54,
          borderRadius: TOKEN.radius.card,
          border: TOKEN.action.primary.border,
          background: saving ? TOKEN.ink.meta : TOKEN.action.primary.background,
          boxShadow: saving ? TOKEN.shadow.none : TOKEN.action.primary.shadowSoft,
          color: TOKEN.ink.inverse,
          fontFamily: "inherit",
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.bold,
          cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "שומר..." : saveLabel}
      </button>
    </div>
  );
}

export function BuilderTextAreaField({
  label,
  hint,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        margin: "0 18px",
      }}
    >
      <span
        style={{
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.bold,
          lineHeight: 1.4,
        }}
      >
        {label}
      </span>
      {hint ? (
        <span
          style={{
            color: TOKEN.ink.muted,
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.medium,
            lineHeight: 1.45,
          }}
        >
          {hint}
        </span>
      ) : null}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        style={{
          width: "100%",
          minHeight: Math.max(96, rows * 30),
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.radius.input,
          background: TOKEN.surface.inset,
          padding: "13px 14px",
          color: TOKEN.ink.primary,
          fontFamily: "inherit",
          fontSize: TOKEN.font.body,
          lineHeight: 1.5,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}
export function BuilderTextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  dir,
  inputMode,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  dir?: "rtl" | "ltr" | "auto";
  inputMode?: "text" | "url" | "email" | "tel" | "search" | "numeric" | "decimal";
  type?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        margin: "0 18px",
      }}
    >
      <span
        style={{
          color: TOKEN.ink.primary,
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.bold,
          lineHeight: 1.4,
        }}
      >
        {label}
      </span>
      {hint ? (
        <span
          style={{
            color: TOKEN.ink.muted,
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.medium,
            lineHeight: 1.45,
          }}
        >
          {hint}
        </span>
      ) : null}
      <input
        type={type}
        inputMode={inputMode}
        dir={dir}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          minHeight: 46,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.radius.input,
          background: TOKEN.surface.inset,
          padding: "13px 14px",
          color: TOKEN.ink.primary,
          fontFamily: "inherit",
          fontSize: TOKEN.font.body,
          lineHeight: 1.5,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

export function ChoiceRow({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "flex-start",
        gap: 13,
        padding: "14px 18px",
        border: 0,
        borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
        background: selected ? TOKEN.brand.soft : TOKEN.surface.card,
        color: TOKEN.ink.primary,
        cursor: "pointer",
        textAlign: "right",
        fontFamily: "inherit",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          marginTop: 2,
          borderRadius: TOKEN.radius.pill,
          border: `2px solid ${selected ? TOKEN.brand.mid : TOKEN.border.hover}`,
          background: selected ? TOKEN.brand.mid : TOKEN.surface.card,
          boxShadow: selected ? TOKEN.shadow.elevated : TOKEN.shadow.none,
          flexShrink: 0,
        }}
      />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: "block",
            color: TOKEN.ink.primary,
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.bold,
            lineHeight: 1.4,
          }}
        >
          {label}
        </span>
        {hint ? (
          <span
            style={{
              display: "block",
              marginTop: 3,
              color: TOKEN.ink.muted,
              fontSize: TOKEN.font.meta,
              fontWeight: TOKEN.weight.medium,
              lineHeight: 1.45,
            }}
          >
            {hint}
          </span>
        ) : null}
      </span>
    </button>
  );
}
export function BotIdentityHero({
  icon,
  name,
  status,
}: {
  icon: ReactNode;
  name: string;
  status: string;
}) {
  return (
    <section
      style={{
        margin: "12px 18px 0",
        borderRadius: TOKEN.radius.modal,
        padding: TOKEN.space.lg,
        background: TOKEN.brand.gradient,
        color: TOKEN.ink.inverse,
        boxShadow: TOKEN.action.primary.shadow,
        display: "flex",
        alignItems: "center",
        gap: 15,
      }}
    >
      <div
        style={{
          width: 58,
          height: 58,
          borderRadius: TOKEN.radius.card,
          background: TOKEN.action.glass.background,
          border: TOKEN.action.glass.border,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          color: TOKEN.ink.inverse,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: TOKEN.font.display,
            fontWeight: TOKEN.weight.bold,
            lineHeight: 1.25,
          }}
        >
          {name}
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: TOKEN.font.meta,
            fontWeight: TOKEN.weight.medium,
            lineHeight: 1.45,
            opacity: 0.92,
          }}
        >
          {status}
        </div>
      </div>
    </section>
  );
}

export function HubAreaCard({
  href,
  icon,
  title,
  summary,
  statusLabel,
  inactive = false,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  summary: string;
  statusLabel?: string;
  inactive?: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        margin: "0 18px 11px",
        padding: "15px 14px",
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: TOKEN.radius.card,
        background: inactive ? TOKEN.surface.inset : TOKEN.surface.card,
        textDecoration: "none",
        color: TOKEN.ink.primary,
        opacity: inactive ? 0.74 : 1,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: TOKEN.radius.card,
          background: inactive ? TOKEN.surface.card : TOKEN.surface.inset,
          border: `1px solid ${inactive ? TOKEN.border.DEFAULT : TOKEN.border.DEFAULT}`,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          color: inactive ? TOKEN.ink.meta : TOKEN.brand.mid,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              lineHeight: 1.35,
              color: inactive ? TOKEN.ink.secondary : TOKEN.ink.primary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
          {statusLabel ? (
            <span
              style={{
                borderRadius: TOKEN.radius.pill,
                padding: "3px 8px",
                background: inactive ? TOKEN.surface.card : TOKEN.brand.soft,
                color: inactive ? TOKEN.ink.muted : TOKEN.brand.mid,
                border: `1px solid ${inactive ? TOKEN.border.DEFAULT : TOKEN.brand.softBorder}`,
                fontSize: TOKEN.font.caption,
                fontWeight: TOKEN.weight.semibold,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {statusLabel}
            </span>
          ) : null}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: TOKEN.font.meta,
            color: TOKEN.ink.muted,
            fontWeight: TOKEN.weight.medium,
            lineHeight: 1.45,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </div>
      </div>
      <span
        aria-hidden
        style={{
          color: TOKEN.ink.meta,
          flexShrink: 0,
          fontSize: TOKEN.font.display,
          lineHeight: 1,
        }}
      >
        ‹
      </span>
    </Link>
  );
}
export const areaPanelStyle: CSSProperties = {
  margin: "14px 18px 0",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  overflow: "hidden",
  boxShadow: TOKEN.shadow.elevated,
};
