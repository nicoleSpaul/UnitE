"use client";
import { useState, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import LogoIcon from "../../public/uniteemricon.png";
 
type SubItem = {
    label: string;
    href: string;
}

type NavItem = {
  label: string;
  icon: ReactNode;
  href?: string;
  children?: SubItem[];
};

const iconProps = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "h-5 w-5 shrink-0",
  "aria-hidden": true,
};

const items: NavItem[] = [
    {
        label: "Dashboard",
        href: "/pages/dashboard",
        icon: ""
    },
    {
        label: "Conversion",
        icon: (
            <svg {...iconProps}>
                <path d="M8 3 4 7l4 4" />
                <path d="M4 7h16" />
                <path d="m16 21 4-4-4-4" />
                <path d="M20 17H4" />
            </svg>
        ),
        children: [
            { label: "File", href: "/pages/input/file-conversion"},
            { label: "Speech", href: "/pages/input/speech-conversion"},
            { label: "Image", href: "/pages/input/image-conversion"},
        ],
    },
    {
        label: "Output",
        icon: (
            <svg {...iconProps}>
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
        ),
        children: [
            { label: "Text", href: "/pages/output/text-output"},
            { label: "Audio", href: "/pages/output/audio-output"},
        ]
    },
]

const hoverFx = 
"group relative border-b-2 border-transparent transition-colors duration-150 hover:border-yellow-400 focus-visible:border-yellow-400 focus-visible:text-blue-950";

// Four-pointed star shown on hover.
function Star({ position = "right-3" }: { position?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`pointer-events-none absolute ${position} top-1/2 h-3.5 w-3.5 -translate-y-1/2 scale-50 text-yellow-400 opacity-0 transition duration-200 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100 motion-reduce:transition-none`}
    >
      <path d="M12 0 14 10 24 12 14 14 12 24 10 14 0 12 10 10Z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      {...iconProps}
      className={`ml-auto h-4 w-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${
        open ? "rotate-90" : ""
      }`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export default function SideNav({
  activeHref = "/",
  onNavigate,
}: {
  activeHref?: string;
  onNavigate?: (href: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState(activeHref);
 
  // If open page is in subsection, open section
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      items
        .filter((i) => i.children?.some((c) => c.href === activeHref))
        .map((i) => [i.label, true])
    )
  );
 
  // Route to given href for each link
  const go = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (onNavigate) {
      e.preventDefault();
      onNavigate(href);
    }
    setActive(href);
  };
 
  // Toggle sections: collapse if another is clicked, expand if clicked
  const toggleSection = (label: string) => {
    if (collapsed) {
      setCollapsed(false);
      setOpen((o) => ({ ...o, [label]: true }));
    } else {
      setOpen((o) => ({ ...o, [label]: !o[label] }));
    }
  };
 
  return (
    <nav
      aria-label="Main"
      className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-blue-900 bg-blue-950 text-blue-100 transition-[width] duration-200 motion-reduce:transition-none ${
        collapsed ? "w-16" : "w-56"
      }`}
    >

      <ul className="flex-1 space-y-1 overflow-y-auto p-2">

        <div className="flex flex-row pb-2 m-2">
            <Image src={LogoIcon} alt="Icon" className="w-8 h-6"/>
        </div>

        {items.map((item) => {
          if (!item.children) {
            const isActive = active === item.href;
            return (
              <li key={item.label}>
                <a
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={isActive ? "page" : undefined}
                  onClick={(e) => go(e, item.href!)}
                  className={`${hoverFx} flex items-center gap-3 px-3 py-2 text-sm font-medium outline-none ${
                    isActive ? "bg-blue-800 text-white" : ""
                  }`}
                >
                  {item.icon}
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {!collapsed && <Star />}
                </a>
              </li>
            );
          }
 
          const isOpen = !!open[item.label] && !collapsed;
          const hasActiveChild = item.children.some((c) => c.href === active);
          const panelId = `subnav-${item.label.toLowerCase().replace(/\s+/g, "-")}`;
 
          return (
            <li key={item.label}>
              <button
                type="button"
                onClick={() => toggleSection(item.label)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                title={collapsed ? item.label : undefined}
                className={`${hoverFx} flex w-full items-center gap-3 px-3 py-2 text-sm font-medium outline-none ${
                  hasActiveChild && !isOpen ? "bg-blue-800 text-white" : ""
                }`}
              >
                {item.icon}
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && <Star position="right-9" />}
                {!collapsed && <Chevron open={isOpen} />}
              </button>
 
              <div
                id={panelId}
                className={`grid transition-[grid-template-rows,visibility] duration-200 motion-reduce:transition-none ${
                  isOpen ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
                }`}
              >
                <div className="min-h-0 overflow-hidden">
                  <ul className="space-y-1 py-1">
                    {item.children.map((sub) => {
                      const isActive = active === sub.href;
                      return (
                        <li key={sub.href}>
                          <a
                            href={sub.href}
                            aria-current={isActive ? "page" : undefined}
                            onClick={(e) => go(e, sub.href)}
                            className={`${hoverFx} flex items-center py-2 pl-14 pr-3 text-sm outline-none font-medium text-white`}
                          >
                            <span className="truncate">{sub.label}</span>
                            <Star />
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-blue-900 p-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          className={`${hoverFx} flex w-full items-center gap-3 px-3 py-2 text-sm font-medium outline-none`}
        >
          <svg
            {...iconProps}
            className={`h-5 w-5 shrink-0 transition-transform ${
              collapsed ? "rotate-180" : ""
            }`}
          >
            <path d="m15 6-6 6 6 6" />
          </svg>
          {!collapsed && <span>Collapse</span>}
          {!collapsed && <Star />}
        </button>
      </div>
    </nav>
  );
}

