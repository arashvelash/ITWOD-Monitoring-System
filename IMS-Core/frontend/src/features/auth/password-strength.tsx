import { Progress } from '@/components/ui/misc';
import { passwordScore } from './password-score';

const LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

export function PasswordStrength({ password }: { password: string }) {
  const score = passwordScore(password);
  const tone = score <= 1 ? 'destructive' : score === 2 ? 'warning' : 'success';
  return (
    <div className="grid gap-1.5" aria-live="polite">
      <Progress value={(score / 4) * 100} tone={tone} />
      <span className="text-[12px] text-muted-foreground">Strength: {LABELS[score]}</span>
    </div>
  );
}
