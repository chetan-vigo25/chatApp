// Run: node --test __tests__/
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/utils/businessChat');

test('flag on the chat item', () => {
  assert.equal(B.isBusinessChat({ chatType: 'private', isBusinessSender: true }), true);
});

test('flag on peerUser', () => {
  assert.equal(B.isBusinessChat({ chatType: 'private', peerUser: { isBusinessSender: true } }), true);
});

test('missing or false flag is not business', () => {
  assert.equal(B.isBusinessChat({ chatType: 'private' }), false);
  assert.equal(B.isBusinessChat({ chatType: 'private', isBusinessSender: false }), false);
  assert.equal(B.isBusinessChat(null), false);
});

test('group and broadcast are never business', () => {
  assert.equal(B.isBusinessChat({ chatType: 'group', isBusinessSender: true }), false);
  assert.equal(B.isBusinessChat({ isGroup: true, peerUser: { isBusinessSender: true } }), false);
  assert.equal(B.isBusinessChat({ chatType: 'broadcast', isBusinessSender: true }), false);
});

test('subtitle and composer notice', () => {
  assert.equal(B.BUSINESS_SUBTITLE, 'Business account');
  assert.match(B.BUSINESS_COMPOSER_NOTICE, /business account/i);
});

test('a lean update never clears the flag; an explicit value wins', () => {
  assert.equal(B.mergeBusinessFlag({ chatId: 'x', lastMessage: {} }, { isBusinessSender: true }), true);
  assert.equal(B.mergeBusinessFlag({ isBusinessSender: false }, { peerUser: { isBusinessSender: true } }), false);
  assert.equal(B.mergeBusinessFlag({}, {}), undefined);
});

test('pickers catch a merged row that lost the flag', () => {
  const set = B.businessPeerIdSet(
    [{ chatType: 'private', peerUserId: 'b1', isBusinessSender: true }, { chatType: 'private', peerUserId: 'n1' }],
    { c: { chatType: 'private', peerUser: { _id: 'b2', isBusinessSender: true } } },
  );
  assert.equal(set.has('b1') && set.has('b2') && !set.has('n1'), true);
  assert.equal(B.isBusinessRow({ chatType: 'private', peerUserId: 'b1' }, set), true);
  assert.equal(B.isBusinessRow({ chatType: 'group', peerUserId: 'b1' }, set), false);
});

test('profile probe heuristic', () => {
  assert.equal(B.looksLikeBusinessSender({ business: { name: 'Juber' } }), true);
  assert.equal(B.looksLikeBusinessSender({ isSenderProfile: true }), true);
  assert.equal(B.looksLikeBusinessSender({ userType: 'organization' }), true);
  assert.equal(B.looksLikeBusinessSender({ userType: 'organization', mobile: { number: '9876543210' } }), false);
  assert.equal(B.looksLikeBusinessSender({ userType: 'user' }), false);
  assert.equal(B.looksLikeBusinessSender(null), false);
});

test('call registry (startCall guard)', () => {
  B.setKnownBusinessPeers(new Set(['b9']));
  assert.equal(B.isKnownBusinessPeer('b9'), true);
  assert.equal(B.isKnownBusinessPeer('x'), false);
  B.addProbedBusinessPeer('p1');
  assert.equal(B.isKnownBusinessPeer('p1'), true);
});
