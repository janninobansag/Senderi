import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

export const informationPageIds = [
  "privacy",
  "terms",
  "help",
  "community-guidelines",
  "about",
] as const;

export type InformationPageId = typeof informationPageIds[number];

interface InformationSection {
  title: string;
  content: ReactNode;
}

interface InformationPageContent {
  label: string;
  title: string;
  introduction: string;
  draftNotice?: string;
  sections: InformationSection[];
}

const supportContact = <a href="mailto:jannino.dev@gmail.com">jannino.dev@gmail.com</a>;

export const informationPageContent: Record<InformationPageId, InformationPageContent> = {
  privacy: {
    label: "Privacy",
    title: "Privacy at Senderi",
    introduction: "This notice explains the information Senderi currently handles to provide accounts, posts, messages, and notifications.",
    sections: [
      {
        title: "Information used by Senderi",
        content: <>
          <p>When you create an account, Senderi stores your display name, email address, and password hash. You may also add a bio, location, website, profile photo, and cover photo.</p>
          <p>Senderi stores the content and activity needed for the features you use, including posts and their audience settings, photos, comments, reactions, shares, friend requests, messages, and notifications. If you enable device notifications, Senderi stores the browser push subscription needed to deliver them. When you report content, Senderi stores your selected reason, optional details, a short text excerpt, and whether the content includes a photo. Moderators can view a reported photo through its existing Cloudinary upload while reviewing the report.</p>
        </>,
      },
      {
        title: "How information is used and stored",
        content: <>
          <p>Information is used to operate accounts, show content to the audience selected for it, deliver messages and notifications, recover accounts, and protect the service from abuse.</p>
          <p>Senderi uses MongoDB for application records, Cloudinary for profile, cover, post, and chat images, and Brevo to deliver password-reset emails. When you enable browser or phone notifications, delivery uses the push service associated with your browser or device.</p>
        </>,
      },
      {
        title: "Cookies and browser storage",
        content: <>
          <p>Senderi uses an HttpOnly session cookie to keep you signed in. It is scoped to the API, uses SameSite=Lax, and expires after seven days; production sessions also use the Secure attribute.</p>
          <p>Your browser stores recent search terms in local storage. Senderi also uses local or session storage for interface state, such as whether an update notice or notification prompt has already been shown.</p>
        </>,
      },
      {
        title: "Who can see your content",
        content: <p>Posts and shares have audience settings such as Public, Friends, and Only me. Choose an audience before posting. Messages are intended for the people in that conversation. Content you make Public may be visible to people outside your friend list.</p>,
      },
      {
        title: "Retention and privacy requests",
        content: <>
          <p>Senderi keeps account information and posts, shares, comments, reactions, messages, and uploaded images until you delete the content or permanently delete your account. Open report records and their review snapshots are deleted after seven days if they remain open; if a moderator resolves or dismisses a report sooner, its record is deleted seven days after that decision. Separate moderation audit entries and notifications may remain after the report record is deleted. You can delete individual content where the feature provides that option. Permanently deleting your account removes reports you submitted and reports about content you owned. Backups are inactive for the current MongoDB Atlas cluster, and Cloudinary automatic backup for new uploads is off.</p>
          <p>You can permanently delete your account from <Link to="/settings">Settings</Link>. This removes your account and associated content from Senderi’s active records and requests deletion of its hosted profile, post, and chat images. Cloudinary CDN cached copies may take up to 30 days to expire, and copies cached by browsers or other services may persist longer. Deactivation only signs you out and keeps your profile and content; signing in again reactivates the account.</p>
          <p>To ask about your personal information or request access, correction, objection, erasure or blocking, or data portability where available under applicable law, email {supportContact}. Senderi may need to verify your identity before handling a request.</p>
        </>,
      },
      {
        title: "Operator and contact",
        content: <p>Senderi is operated by <strong>Senderi Team</strong> in <strong>the Philippines</strong>. For privacy questions or requests, contact {supportContact}. Effective date: <strong>the date this notice is published</strong>.</p>,
      },
    ],
  },
  terms: {
    label: "Terms",
    title: "Senderi Terms of Use",
    introduction: "These starter terms describe basic expectations for using Senderi. They need the operator and jurisdiction details below before public launch.",
    draftNotice: "Have these Terms reviewed for local legal requirements before public launch.",
    sections: [
      {
        title: "Using an account",
        content: <p>You may use Senderi only if you can legally agree to these terms and meet the minimum age required where you live. Provide accurate account information and keep your sign-in details private. Contact {supportContact} if you need account-access help.</p>,
      },
      {
        title: "Your content and audience settings",
        content: <p>You are responsible for the content you post and for having permission to share it. You retain your rights in your content and allow Senderi to host, process, and display it as needed to operate the features you use, following the audience settings you choose. Public content may be visible outside your friend list.</p>,
      },
      {
        title: "Use Senderi respectfully",
        content: <p>Do not use Senderi to threaten or harass people, impersonate others, send spam, expose someone’s private information without permission, or share unlawful content. Follow the <Link to="/community-guidelines">Community Guidelines</Link>.</p>,
      },
      {
        title: "Moderation and service changes",
        content: <p>Senderi may hide content or restrict accounts when needed to enforce these terms, protect people, or maintain the service. Features may change or become unavailable as Senderi is updated.</p>,
      },
      {
        title: "Details to complete before launch",
        content: <p>Operator: <strong>Senderi Team</strong>. Jurisdiction: <strong>the Philippines</strong>. Effective date: <strong>the date these Terms are published</strong>. Have local review complete any required warranty, liability, dispute, and consumer-rights terms before launch. Contact: {supportContact}.</p>,
      },
    ],
  },
  help: {
    label: "Help",
    title: "How can we help?",
    introduction: "Quick help for the features currently available in Senderi.",
    sections: [
      {
        title: "Account access",
        content: <p>Use the <Link to="/forgot-password">password reset page</Link> if you cannot sign in. If you still need help, contact {supportContact}. Never send your password or a password-reset link to support.</p>,
      },
      {
        title: "Profiles and posts",
        content: <p>You can edit your profile, choose an audience for a post, and add or recrop profile and cover photos. Public posts can be seen outside your friend list; choose Friends or Only me when that better fits what you are sharing.</p>,
      },
      {
        title: "Comments, shares, and messages",
        content: <p>Posts support comments, replies, reactions, and sharing. Messages are available from the Chats area. If something is not working, include the page or profile URL and a short description when contacting support, but leave out passwords and private message contents.</p>,
      },
      {
        title: "Notifications and safety",
          content: <p>Use Report in a post, comment, or chat message menu to send a safety concern to the moderators. Reports are reviewed by Senderi moderators. Open your profile menu and choose <Link to="/reports">My reports</Link> to check their status. Reports expire after seven days if they remain open, or seven days after a moderator resolves or dismisses them. A moderator may dismiss a report or hide the reported content. If content is hidden, its owner receives a notification; the reporter's identity is not shared. Hidden chat messages can be restored if the moderation decision changes. Device notifications are optional and depend on your browser or phone permissions. For privacy questions, contact {supportContact}.</p>,
      },
    ],
  },
  "community-guidelines": {
    label: "Community Guidelines",
    title: "Community Guidelines",
    introduction: "Senderi works best when people can share and connect with care. These guidelines apply to posts, comments, profiles, shares, and messages.",
    sections: [
      {
        title: "Treat people with respect",
        content: <p>Do not threaten, bully, harass, or target people with hateful abuse. Respect people’s boundaries when they ask you to stop contacting them.</p>,
      },
      {
        title: "Respect privacy and consent",
        content: <p>Do not post someone else’s private contact details, private messages, or images without permission. Check your post’s audience before sharing personal or sensitive information.</p>,
      },
      {
        title: "Keep the service authentic and safe",
        content: <p>Do not impersonate another person, spam people, manipulate engagement, or use Senderi to share unlawful or dangerous content. Only share images and other material you have the right to use.</p>,
      },
      {
        title: "Raise a concern",
        content: <p>If you see a concern, contact {supportContact} and include a link to the relevant profile or post. Senderi may hide content or restrict accounts that violate these guidelines.</p>,
      },
    ],
  },
  about: {
    label: "About",
    title: "About Senderi",
    introduction: "Senderi is a place to share updates and photos, keep up with friends, and continue conversations through comments and messages.",
    sections: [
      {
        title: "Stay connected",
        content: <p>Create a profile, choose who can see your posts, connect with friends, and share conversations in one place.</p>,
      },
      {
        title: "Contact",
        content: <p>Questions about Senderi? Reach us at {supportContact}.</p>,
      },
    ],
  },
};

export function InformationPage({ page }: { page: InformationPageId }) {
  const content = informationPageContent[page];

  return (
    <main className="information-page-wrap">
      <article className="information-page surface-card" aria-labelledby="information-page-title">
        <span className="eyebrow">Senderi · {content.label}</span>
        <h1 id="information-page-title">{content.title}</h1>
        <p className="information-page-introduction">{content.introduction}</p>
        {content.draftNotice && (
          <p className="information-page-draft" role="note">
            {content.draftNotice}
          </p>
        )}
        <div className="information-page-sections">
          {content.sections.map((section) => (
            <section key={section.title} aria-labelledby={`information-section-${section.title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
              <h2 id={`information-section-${section.title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{section.title}</h2>
              {section.content}
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}

export function SiteFooter({ placement }: { placement: "global" | "sidebar" | "menu" }) {
  return (
    <footer className={`site-footer site-footer-${placement}`}>
      <div className="site-footer-inner">
        <nav aria-label="Site information" className="site-footer-links">
          {informationPageIds.map((page, index) => (
            <Fragment key={page}>
              {index > 0 && <span aria-hidden="true">·</span>}
              <Link to={`/${page}`}>{informationPageContent[page].label}</Link>
            </Fragment>
          ))}
        </nav>
      </div>
    </footer>
  );
}
