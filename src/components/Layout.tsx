import type { ReactNode } from "react";
import type { Page } from "../App";

interface NavItem {
  id: Page;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "info",     label: "CHD Info",    icon: "ℹ" },
  { id: "create",   label: "Create CHD",  icon: "⊕" },
  { id: "extract",  label: "Extract CHD", icon: "⊖" },
  { id: "convert",  label: "Convert CHD", icon: "↻" },
  { id: "verify",   label: "Verify CHD",  icon: "✓" },
  { id: "audit",    label: "DAT Audit",   icon: "≡" },
];

interface LayoutProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
}

export default function Layout({ currentPage, onNavigate, children }: LayoutProps) {
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-logo">
          ROM<span>Cruncher</span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <div
              key={item.id}
              className={`nav-item ${currentPage === item.id ? "active" : ""}`}
              onClick={() => onNavigate(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div
            className={`nav-item ${currentPage === "settings" ? "active" : ""}`}
            onClick={() => onNavigate("settings")}
          >
            <span className="nav-icon">⚙</span>
            Settings
          </div>
        </div>
      </aside>
      <main className="main-content">
        <div className="page-content">{children}</div>
      </main>
    </>
  );
}
