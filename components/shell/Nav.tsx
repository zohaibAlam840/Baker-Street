"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "@/lib/auth/roles";
import { ICONS, IconMore } from "./icons";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Desktop navigation. Hidden below `lg`, where the tab bar takes over. */
export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            title={item.description}
            className={[
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
              active
                ? "bg-[var(--surface-sunken)] font-medium text-[var(--ink-primary)]"
                : "text-[var(--ink-secondary)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-primary)]",
            ].join(" ")}
          >
            <span
              className={[
                "grid size-7 shrink-0 place-items-center rounded-lg",
                active ? "bg-[var(--brand)] text-white" : "text-[var(--ink-muted)]",
              ].join(" ")}
            >
              <Icon className="size-4" />
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Mobile tab bar.
 *
 * Fixed to the bottom, inside the safe area so it clears the home indicator on
 * a phone. Four destinations plus More — past five the targets get too narrow
 * to hit reliably with a thumb.
 */
export function BottomNav({
  items,
  moreHref = "/menu",
}: {
  items: NavItem[];
  moreHref?: string;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--rule-hairline)] bg-[var(--surface-1)]/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                // 56px tall: comfortably above the 44px minimum touch target.
                className="flex h-14 flex-col items-center justify-center gap-1"
              >
                <Icon
                  className={
                    active
                      ? "size-[22px] text-[var(--brand)]"
                      : "size-[22px] text-[var(--ink-muted)]"
                  }
                />
                <span
                  className={
                    active
                      ? "text-[0.625rem] font-medium text-[var(--ink-primary)]"
                      : "text-[0.625rem] text-[var(--ink-muted)]"
                  }
                >
                  {item.short}
                </span>
              </Link>
            </li>
          );
        })}

        <li className="flex-1">
          <Link
            href={moreHref}
            aria-current={pathname === moreHref ? "page" : undefined}
            className="flex h-14 flex-col items-center justify-center gap-1"
          >
            <IconMore
              className={
                pathname === moreHref
                  ? "size-[22px] text-[var(--brand)]"
                  : "size-[22px] text-[var(--ink-muted)]"
              }
            />
            <span
              className={
                pathname === moreHref
                  ? "text-[0.625rem] font-medium text-[var(--ink-primary)]"
                  : "text-[0.625rem] text-[var(--ink-muted)]"
              }
            >
              More
            </span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}
