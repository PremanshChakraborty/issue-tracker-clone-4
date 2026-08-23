import type { Notification, IssueConfig, Priority, DailyDigestPayload } from '@issue-tracker/types';

const TELEGRAM_API = 'https://api.telegram.org';

// ─── Priority display helpers ──────────────────────────────────────────────────

const PRIORITY_EMOJI: Record<Priority, string> = {
  critical: '🚨',
  watching: '👀',
  low: '🔵',
};

// ─── Message building ──────────────────────────────────────────────────────────

function buildInstantMessage(notif: Notification, config: IssueConfig): string {
  const emoji = PRIORITY_EMOJI[notif.priority_at_time];
  const issueUrl = `https://github.com/${config.repo}/issues/${config.issue_number}`;
  const { actor, summary, detail } = notif.payload;

  return [
    `${emoji} <b>[${notif.priority_at_time.toUpperCase()}]</b> ${config.repo}#${config.issue_number}`,
    `<i>${escapeHtml(config.title)}</i>`,
    ``,
    `↳ ${escapeHtml(summary)}`,
    detail ? `↳ <code>${escapeHtml(detail.slice(0, 300))}</code>` : '',
    ``,
    `→ <a href="${issueUrl}">View issue</a>`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function buildDailyDigestMessage(payload: DailyDigestPayload, configMap: Map<string, IssueConfig>): string {
  const lines: string[] = [`🌅 <b>Daily Issue Digest</b> (${payload.date})`, ''];

  if (payload.low.length > 0) {
    lines.push(`🗄️ <b>Low Priority Activity</b>`);
    for (const item of payload.low) {
      const config = configMap.get(item.ref)!;
      const url = `https://github.com/${config.repo}/issues/${config.issue_number}`;
      const cStr = item.total_comments_today > 0 ? `💬 ${item.total_comments_today} comment${item.total_comments_today > 1 ? 's' : ''} ` : '';
      const eStr = item.total_events_today > 0 ? `🔄 ${item.total_events_today} event${item.total_events_today > 1 ? 's' : ''}` : '';
      const iStr = item.is_inactive ? `📉 <i>Inactive for ${item.inactivity_days} days</i> ` : '';
      lines.push(`• <a href="${url}">${config.repo}#${config.issue_number}</a>: ${iStr}${cStr}${eStr}`);
    }
    lines.push('');
  }

  if (payload.watching.length > 0) {
    lines.push(`👀 <b>Watching Updates</b>`);
    for (const item of payload.watching) {
      const config = configMap.get(item.ref)!;
      const url = `https://github.com/${config.repo}/issues/${config.issue_number}`;
      lines.push(`• <b><a href="${url}">${config.repo}#${config.issue_number}</a></b>`);
      
      if (item.is_inactive) {
        lines.push(`  ↳ 📉 <i>Inactive for ${item.inactivity_days} days</i>`);
      }
      if (item.events_today > 0) {
        lines.push(`  ↳ 🔄 ${item.events_today} event${item.events_today > 1 ? 's' : ''}`);
      }
      if (item.grouped_comments) {
         const { authorLogin, roleLabel, first_body_snippet, total_count } = item.grouped_comments;
         const moreText = total_count > 1 ? ` (+${total_count - 1} more)` : '';
         lines.push(`  ↳ 💬 @${authorLogin}${roleLabel} commented${moreText}`);
         lines.push(`    <code>${escapeHtml(first_body_snippet)}</code>`);
      }
    }
    lines.push('');
  }

  if (payload.critical_summary.length > 0) {
    lines.push(`🚨 <b>Critical Health</b>`);
    for (const item of payload.critical_summary) {
       const config = configMap.get(item.ref)!;
       const url = `https://github.com/${config.repo}/issues/${config.issue_number}`;
       const cStr = item.comments_today > 0 ? `💬 ${item.comments_today} comment${item.comments_today > 1 ? 's' : ''} ` : '';
       const eStr = item.events_today > 0 ? `🔄 ${item.events_today} event${item.events_today > 1 ? 's' : ''}` : '';
       const iStr = item.is_inactive ? `📉 <i>Inactive for ${item.inactivity_days} days</i> ` : '';
       lines.push(`• <a href="${url}">${config.repo}#${config.issue_number}</a>: ${iStr}${cStr}${eStr}`);
    }
    lines.push('');
  }

  if (payload.low.length === 0 && payload.watching.length === 0 && payload.critical_summary.length === 0) {
     lines.push('<i>No activity to report today.</i>');
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Telegram send ─────────────────────────────────────────────────────────────

async function sendMessage(
  text: string,
  token: string,
  chatId: string,
): Promise<number> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const body = (await response.json()) as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!body.ok) {
    throw new Error(`Telegram API error: ${body.description ?? 'unknown'}`);
  }

  return body.result?.message_id ?? 0;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function sendInstant(
  notif: Notification,
  config: IssueConfig,
  token: string,
  chatId: string,
): Promise<number> {
  const text = buildInstantMessage(notif, config);
  const messageId = await sendMessage(text, token, chatId);
  console.log(
    `  📨 Sent [${notif.type}] for ${notif.issue_ref} (msg_id: ${messageId})`,
  );
  return messageId;
}

export async function sendDailyDigest(
  payload: DailyDigestPayload,
  configMap: Map<string, IssueConfig>,
  token: string,
  chatId: string,
): Promise<number> {
  const text = buildDailyDigestMessage(payload, configMap);
  const messageId = await sendMessage(text, token, chatId);
  console.log(`  🌅 Sent Daily Digest (msg_id: ${messageId})`);
  return messageId;
}
