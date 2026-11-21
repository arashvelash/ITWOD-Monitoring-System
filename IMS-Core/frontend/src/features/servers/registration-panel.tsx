import { KeyRound, ShieldCheck, TimerReset } from 'lucide-react';
import { SecretField } from '@/components/common/copy-button';
import type { RegistrationInfo } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';

/** Shows the one-time registration details right after a server/token is created. */
export function RegistrationPanel({ info }: { info: RegistrationInfo }) {
  const ubuntu = info.server.type === 'UBUNTU';
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3 rounded-xl bg-warning/12 p-3.5 text-[13px]">
        <KeyRound className="mt-0.5 size-4 shrink-0" />
        <p>
          The registration token is shown <strong>only once</strong>. It can be used a single time and expires at{' '}
          <span className="font-medium">{formatDateTime(info.expiresAt)}</span>.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SecretField label="Node ID" value={info.server.nodeId} />
        <SecretField label="Core URL" value={info.coreUrl} />
      </div>
      <SecretField label="Registration token" value={info.registrationToken} />
      <div className="grid gap-2">
        <p className="text-sm font-medium">{ubuntu ? 'Install on the Ubuntu server (as root):' : 'Register the cPanel agent (SSH / cPanel Terminal):'}</p>
        <SecretField label={ubuntu ? 'Install command' : 'Register command'} value={info.installCommand} multiline />
        {ubuntu ? (
          <ol className="ml-4 list-decimal space-y-1 text-[13px] text-muted-foreground">
            <li>Run the command above on the server.</li>
            <li>Enter the Core URL and paste the registration token when asked.</li>
            <li>The server turns online here within a few seconds.</li>
          </ol>
        ) : (
          <ol className="ml-4 list-decimal space-y-1 text-[13px] text-muted-foreground">
            <li>Upload the IMS cPanel Agent to ~/ims-agent (outside public_html).</li>
            <li>Run the register command above.</li>
            <li>Add the cron job it prints (every 5 minutes).</li>
          </ol>
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-success" /> Outbound-only connection, signed with Ed25519 + HMAC
        </span>
        <span className="flex items-center gap-1.5">
          <TimerReset className="size-3.5" /> Token invalid after first use
        </span>
      </div>
    </div>
  );
}
