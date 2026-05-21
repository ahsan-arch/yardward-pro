import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { api } from "@/lib/api";
import { driverById } from "@/data/mockData";
import { CheckCircle2, XCircle, AlertCircle, Plus, Trash2, Copy } from "lucide-react";
import { useState } from "react";
import type { TokenScope } from "@/types/domain";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/settings")({
  head: () => ({ meta: [{ title: "Settings — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  return (
    <AdminShell title="Settings">
      <Tabs defaultValue="org">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="org">Organization</TabsTrigger>
          <TabsTrigger value="users">Users & roles</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="tokens">Driver tokens</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
        </TabsList>

        <TabsContent value="org" className="mt-4">
          <OrgTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="integrations" className="mt-4">
          <IntegrationsTab />
        </TabsContent>
        <TabsContent value="tokens" className="mt-4">
          <TokensTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab />
        </TabsContent>
        <TabsContent value="billing" className="mt-4">
          <BillingTab />
        </TabsContent>
      </Tabs>
    </AdminShell>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5">
      <h3 className="font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}

function OrgTab() {
  return (
    <Card title="Organization profile">
      <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
        <div>
          <Label>Business name</Label>
          <Input defaultValue="FleetOps Haulage Co." />
        </div>
        <div>
          <Label>Tax / ABN</Label>
          <Input defaultValue="48 102 877 990" className="font-mono" />
        </div>
        <div className="sm:col-span-2">
          <Label>Address</Label>
          <Input defaultValue="Yard 7, 22 Quarry Ln" />
        </div>
        <div>
          <Label>Timezone</Label>
          <Select defaultValue="local">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">America/Toronto</SelectItem>
              <SelectItem value="utc">UTC</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Currency</Label>
          <Select defaultValue="cad">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cad">CAD</SelectItem>
              <SelectItem value="usd">USD</SelectItem>
              <SelectItem value="aud">AUD</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button
        className="mt-4 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        onClick={() => toast.success("Settings saved")}
      >
        Save changes
      </Button>
    </Card>
  );
}

function UsersTab() {
  const { drivers, mechanics } = useData();
  const all = [
    ...drivers,
    ...mechanics,
    { id: "A-01", name: "Alex Chen", role: "admin" as const, email: "alex@fleetops.co" },
  ];
  return (
    <Card title="Users & roles">
      <div className="flex justify-end mb-3">
        <Button
          size="sm"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Invite user
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Name</th>
            <th className="text-left font-medium px-3 py-2">Email</th>
            <th className="text-left font-medium px-3 py-2">Role</th>
            <th className="text-left font-medium px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {all.map((u) => (
            <tr key={u.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{u.name}</td>
              <td className="px-3 py-2 font-mono text-xs">{u.email}</td>
              <td className="px-3 py-2 text-xs uppercase tracking-wider">{u.role}</td>
              <td className="px-3 py-2">
                <StatusBadge status="Active" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function IntegrationsTab() {
  const integrations = [
    {
      name: "Geotab",
      desc: "GPS + telematics data",
      status: "connected" as const,
      lastSync: "2 min ago",
    },
    {
      name: "Twilio",
      desc: "SMS notifications to drivers",
      status: "connected" as const,
      lastSync: "Live",
    },
    {
      name: "QuickBooks Online",
      desc: "Invoice + payroll sync",
      status: "disconnected" as const,
      lastSync: "—",
    },
    {
      name: "Fleetio",
      desc: "One-time vehicle data migration",
      status: "disconnected" as const,
      lastSync: "—",
    },
  ];
  return (
    <div className="space-y-3 max-w-3xl">
      {integrations.map((i) => (
        <div
          key={i.name}
          className="bg-card border border-border rounded-lg p-4 flex items-center gap-4"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold">{i.name}</h4>
              {i.status === "connected" ? (
                <span className="inline-flex items-center gap-1 text-success text-xs">
                  <CheckCircle2 className="w-3 h-3" /> Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                  <XCircle className="w-3 h-3" /> Disconnected
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{i.desc}</p>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-1">
              Last sync: {i.lastSync}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              {i.status === "connected" ? "Test" : "Connect"}
            </Button>
            {i.status === "connected" && (
              <Button variant="ghost" size="sm" className="text-danger">
                Disconnect
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function TokensTab() {
  const { driverTokens, drivers } = useData();
  const [open, setOpen] = useState(false);
  const [driverId, setDriverId] = useState("");
  const [scope, setScope] = useState<TokenScope>("shift");
  const [hours, setHours] = useState(12);

  async function gen() {
    if (!driverId) {
      toast.error("Pick a driver");
      return;
    }
    const t = await api.generateDriverToken(driverId, scope, hours);
    toast.success(`Token created: ${t.token}`);
    setOpen(false);
  }

  return (
    <Card title="Driver access tokens">
      <div className="flex justify-end mb-3">
        <Button
          size="sm"
          onClick={() => setOpen(true)}
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Generate token
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Token</th>
            <th className="text-left font-medium px-3 py-2">Driver</th>
            <th className="text-left font-medium px-3 py-2">Scope</th>
            <th className="text-left font-medium px-3 py-2">Expires</th>
            <th className="text-left font-medium px-3 py-2">State</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {driverTokens.map((t) => {
            const expired = new Date(t.expiresAt).getTime() < Date.now();
            const state = t.usedAt ? "Used" : expired ? "Expired" : "Active";
            return (
              <tr key={t.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{t.token}</td>
                <td className="px-3 py-2">{driverById(t.driverId)?.name}</td>
                <td className="px-3 py-2 text-xs uppercase">{t.scopedTo}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {new Date(t.expiresAt).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={state} />
                </td>
                <td className="px-3 py-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard?.writeText(`${location.origin}/t/${t.token}`);
                      toast.success("Link copied");
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate driver token</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Driver</Label>
              <Select value={driverId} onValueChange={setDriverId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose driver" />
                </SelectTrigger>
                <SelectContent>
                  {drivers.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as TokenScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="forms">Forms only</SelectItem>
                  <SelectItem value="job">Single job</SelectItem>
                  <SelectItem value="shift">Full shift</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Expires in (hours)</Label>
              <Input type="number" value={hours} onChange={(e) => setHours(+e.target.value)} />
            </div>
            <Button
              onClick={gen}
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              Generate
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function NotificationsTab() {
  return (
    <Card title="Notification preferences">
      <div className="space-y-4 max-w-xl">
        {[
          ["New job assigned (SMS)", true],
          ["Work order awaiting approval", true],
          ["Tool flagged on checklist", true],
          ["GPS mismatch on time entry", true],
          ["PO awaiting approval", true],
          ["Vehicle maintenance overdue", false],
          ["Daily summary email", false],
        ].map(([label, on]) => (
          <div
            key={label as string}
            className="flex items-center justify-between border-b border-border/50 pb-2"
          >
            <div className="text-sm">{label}</div>
            <Switch defaultChecked={on as boolean} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function BillingTab() {
  return (
    <Card title="Billing & subscription">
      <div className="bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 mb-4 flex items-center gap-2 text-sm">
        <AlertCircle className="w-4 h-4 text-amber-brand" />
        Mock-only. Real billing wires in once the backend is ready.
      </div>
      <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
        <div>
          <Label>Plan</Label>
          <div className="text-sm font-medium">Fleet — up to 25 drivers</div>
        </div>
        <div>
          <Label>Renewal</Label>
          <div className="font-mono text-sm">2026-12-01</div>
        </div>
        <div>
          <Label>Seats used</Label>
          <div className="text-sm">8 / 25</div>
        </div>
        <div>
          <Label>Active vehicles</Label>
          <div className="text-sm">6 / 50</div>
        </div>
      </div>
      <Button variant="outline" className="mt-4">
        <Trash2 className="w-4 h-4 text-danger" /> Cancel subscription
      </Button>
    </Card>
  );
}
