interface BrevoResetEmail {
  email: string;
  resetUrl: string;
}

interface BrevoSendPayload {
  sender: { email: string; name: string };
  to: Array<{ email: string }>;
  templateId: number;
  params: { resetUrl: string };
}

export interface BrevoDependencies {
  apiKey: string;
  senderEmail: string;
  templateId: number;
  fetch: typeof globalThis.fetch;
}

export async function sendPasswordResetEmail(
  { email, resetUrl }: BrevoResetEmail,
  overrides: Partial<BrevoDependencies> = {},
): Promise<void> {
  const apiKey = (overrides.apiKey ?? process.env.BREVO_API_KEY ?? "").trim();
  const senderEmail = (overrides.senderEmail ?? process.env.BREVO_SENDER_EMAIL ?? "").trim();
  const templateId = overrides.templateId ?? Number(process.env.BREVO_RESET_TEMPLATE_ID);
  const fetchRequest = overrides.fetch ?? globalThis.fetch;

  if (!apiKey || !senderEmail || !Number.isSafeInteger(templateId) || templateId < 1) {
    throw new Error("Brevo password-reset email is not configured.");
  }

  const payload: BrevoSendPayload = {
    sender: { email: senderEmail, name: "Senderi" },
    to: [{ email }],
    templateId,
    params: { resetUrl },
  };

  const response = await fetchRequest("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Brevo rejected the password-reset email with status ${response.status}.`);
  }
}
