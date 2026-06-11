import { apiCall, apiCallForm } from '../../../Config/Https';

// Categories shown on the Create Ticket screen (value → label).
export const SUPPORT_CATEGORIES = [
  { value: 'technical_issue', label: 'Technical Issue' },
  { value: 'account_issue', label: 'Account Issue' },
  { value: 'payment_issue', label: 'Payment Issue' },
  { value: 'feature_request', label: 'Feature Request' },
  { value: 'bug_report', label: 'Bug Report' },
  { value: 'other', label: 'Other' },
];

export const SUPPORT_STATUS_META = {
  open: { label: 'Open', color: '#2D9BF0' },
  in_progress: { label: 'In Progress', color: '#F5A623' },
  resolved: { label: 'Resolved', color: '#00A884' },
  closed: { label: 'Closed', color: '#8696A0' },
};

export const categoryLabel = (value) =>
  SUPPORT_CATEGORIES.find((c) => c.value === value)?.label || 'Other';

// POST /user/support/ticket/create  (multipart when a screenshot is attached)
export async function createTicket({ subject, category, description, attachment }) {
  const form = new FormData();
  form.append('subject', subject);
  form.append('category', category);
  form.append('description', description);
  if (attachment?.uri) {
    form.append('attachment', {
      uri: attachment.uri,
      name: attachment.name || `screenshot-${Date.now()}.jpg`,
      type: attachment.type || 'image/jpeg',
    });
  }
  const res = await apiCallForm('POST', 'user/support/ticket/create', form, { silent: true });
  if (res?.statusCode === 201 || res?.statusCode === 200) return res.data;
  return Promise.reject(res?.message || 'Failed to create ticket');
}

// POST /user/support/ticket/list
export async function listTickets({ status = '' } = {}) {
  const res = await apiCall('POST', 'user/support/ticket/list', { status, limit: 50 }, { silent: true });
  if (res?.statusCode === 200) return res.data?.docs || [];
  return Promise.reject(res?.message || 'Failed to load tickets');
}

// POST /user/support/ticket/view
export async function viewTicket(ticketId) {
  const res = await apiCall('POST', 'user/support/ticket/view', { ticketId }, { silent: true });
  if (res?.statusCode === 200) return res.data; // { ticket, messages }
  return Promise.reject(res?.message || 'Failed to load ticket');
}

// POST /user/support/ticket/reply  (multipart when an attachment is present)
export async function replyTicket({ ticketId, text, attachment }) {
  if (attachment?.uri) {
    const form = new FormData();
    form.append('ticketId', ticketId);
    form.append('text', text || '');
    form.append('attachment', {
      uri: attachment.uri,
      name: attachment.name || `file-${Date.now()}.jpg`,
      type: attachment.type || 'image/jpeg',
    });
    const res = await apiCallForm('POST', 'user/support/ticket/reply', form, { silent: true });
    if (res?.statusCode === 201 || res?.statusCode === 200) return res.data?.message;
    return Promise.reject(res?.message || 'Failed to send');
  }
  const res = await apiCall('POST', 'user/support/ticket/reply', { ticketId, text }, { silent: true });
  if (res?.statusCode === 201 || res?.statusCode === 200) return res.data?.message;
  return Promise.reject(res?.message || 'Failed to send');
}

// GET /user/support/faqs
export async function getFaqs() {
  const res = await apiCall('GET', 'user/support/faqs', {}, { silent: true });
  if (res?.statusCode === 200) return res.data || []; // [{ category, items: [...] }]
  return Promise.reject(res?.message || 'Failed to load FAQs');
}
