// Default reason set (kept for backward compatibility with existing callers).
export const REPORT_REASONS = [
  { key: 'spam', label: 'Spam' },
  { key: 'harassment', label: 'Harassment' },
  { key: 'abusive_language', label: 'Abusive Language' },
  { key: 'scam', label: 'Scam' },
  { key: 'inappropriate_content', label: 'Inappropriate Content' },
  { key: 'other', label: 'Other' },
];

// Per-target reason catalogues. Keys are submitted verbatim as `reason`; the
// backend maps them to a violation type via substring matching.
export const REPORT_REASONS_BY_TYPE = {
  message: [
    { key: 'spam', label: 'Spam' },
    { key: 'harassment', label: 'Harassment' },
    { key: 'abuse', label: 'Abuse' },
    { key: 'scam', label: 'Fraud / Scam' },
    { key: 'violence', label: 'Violence' },
    { key: 'adult_content', label: 'Adult Content' },
    { key: 'fake_information', label: 'Fake Information' },
    { key: 'hate_speech', label: 'Hate Speech' },
    { key: 'other', label: 'Other' },
  ],
  chat: [
    { key: 'spam', label: 'Spam' },
    { key: 'harassment', label: 'Harassment' },
    { key: 'scam', label: 'Fraud' },
    { key: 'fake_account', label: 'Fake Account' },
    { key: 'inappropriate_content', label: 'Inappropriate Content' },
    { key: 'threats', label: 'Threats' },
    { key: 'other', label: 'Other' },
  ],
  user: [
    { key: 'fake_profile', label: 'Fake Profile' },
    { key: 'spam', label: 'Spam' },
    { key: 'scam', label: 'Scam' },
    { key: 'abuse', label: 'Abuse' },
    { key: 'harassment', label: 'Harassment' },
    { key: 'impersonation', label: 'Impersonation' },
    { key: 'adult_content', label: 'Adult Content' },
    { key: 'other', label: 'Other' },
  ],
  status: [
    { key: 'nudity', label: 'Nudity' },
    { key: 'violence', label: 'Violence' },
    { key: 'spam', label: 'Spam' },
    { key: 'fake_news', label: 'Fake News' },
    { key: 'copyright', label: 'Copyright' },
    { key: 'hate_speech', label: 'Hate Speech' },
    { key: 'other', label: 'Other' },
  ],
  group: [
    { key: 'spam', label: 'Spam' },
    { key: 'illegal_content', label: 'Illegal Content' },
    { key: 'violence', label: 'Violence' },
    { key: 'scam', label: 'Scam' },
    { key: 'adult_content', label: 'Adult Content' },
    { key: 'hate_speech', label: 'Hate Speech' },
    { key: 'other', label: 'Other' },
  ],
};

export const REPORT_TYPE_LABELS = {
  message: 'Message',
  chat: 'Chat',
  user: 'User',
  status: 'Status',
  group: 'Group',
};

export const REPORT_STATUS_LABELS = {
  pending: 'Submitted',
  under_review: 'Under Review',
  reviewing: 'Under Review',
  resolved: 'Resolved',
  rejected: 'Rejected',
  closed: 'Closed',
};
