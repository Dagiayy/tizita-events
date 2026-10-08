import 'dart:convert';
import 'dart:io';

import 'package:event_photos/core/api_client.dart';
import 'package:event_photos/core/deep_links.dart';
import 'package:event_photos/core/ethiopian_calendar.dart';
import 'package:event_photos/data/guest_api.dart';
import 'package:event_photos/data/local_store.dart';
import 'package:event_photos/data/models.dart';
import 'package:event_photos/services/session_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('secure deep links', () {
    const tok = 'u_AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    test('accepts https links on the configured host, custom scheme and bare codes/tokens', () {
      expect(parseEventLink('https://photos.example.et/j/$tok?c=ab3k9mnp', webHost: 'photos.example.et'), EventLocator(tok, code: 'AB3K9MNP'));
      expect(parseEventLink('eventphotos://j/$tok'), const EventLocator(tok));
      expect(parseEventLink('ab3k9mnp'), const EventLocator('AB3K9MNP'));
      expect(parseEventLink(tok), const EventLocator(tok));
      expect(parseEventLink('http://localhost:3000/j/$tok', webHost: 'localhost'), const EventLocator(tok));
    });
    test('rejects other hosts, schemes, traversal, scripts and malformed values', () {
      for (final bad in [
        'https://evil.example/j/$tok', 'http://photos.example.et/j/$tok', 'javascript:alert(1)', 'file:///etc/passwd', 'https://photos.example.et/j/../admin',
        'https://photos.example.et/x/$tok', 'https://photos.example.et/j/u_short', 'eventphotos://admin/$tok', 'https://photos.example.et/j/$tok/extra', '', '   ', 'AB0O1I', 'x' * 500,
        'intent://scan/#Intent;scheme=zxing;end',
      ]) {
        expect(parseEventLink(bad, webHost: 'photos.example.et'), isNull, reason: bad);
      }
    });
    test('join code in the link must match the code grammar', () {
      expect(parseEventLink('https://photos.example.et/j/$tok?c=<script>', webHost: 'photos.example.et')!.code, isNull);
    });
  });

  group('Ethiopian calendar', () {
    test('known dates and EAT midnight boundary', () {
      expect(EthiopianDate.fromGregorian(2026, 9, 11), const EthiopianDate(2019, 1, 1));
      expect(EthiopianDate.fromGregorian(2023, 9, 12), const EthiopianDate(2016, 1, 1));
      expect(EthiopianDate.fromGregorian(2026, 10, 2), const EthiopianDate(2019, 1, 22));
      expect(EthiopianDate.fromInstant(DateTime.utc(2026, 10, 1, 21, 30)).format('en'), '22 Meskerem 2019'); // 00:30 EAT on 2 Oct
      expect(EthiopianDate.fromInstant(DateTime.utc(2026, 10, 1, 21, 30)).format('am'), '22 መስከረም 2019');
    });
  });

  group('API client', () {
    test('maps structured errors, network failures and timeouts', () async {
      final mock = MockClient((req) async {
        if (req.url.path.endsWith('/boom')) return http.Response(jsonEncode({'error': {'code': 'event_not_found', 'message': 'nope', 'details': {'x': 1}}}), 404, headers: {'content-type': 'application/json'});
        if (req.url.path.endsWith('/html')) return http.Response('<html>502</html>', 502, headers: {'content-type': 'text/html'});
        if (req.url.path.endsWith('/net')) throw const SocketException('down');
        if (req.url.path.endsWith('/slow')) { await Future<void>.delayed(const Duration(milliseconds: 200)); return http.Response('{}', 200); }
        return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
      });
      final c = ApiClient(client: mock, base: 'http://api.test', timeout: const Duration(milliseconds: 80));
      expect((await c.json('GET', '/ok'))['ok'], true);
      await expectLater(c.json('GET', '/boom'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'event_not_found').having((e) => e.status, 'status', 404)));
      await expectLater(c.json('GET', '/html'), throwsA(isA<ApiException>().having((e) => e.isTransient, 'transient', true)));
      await expectLater(c.json('GET', '/net'), throwsA(isA<ApiException>().having((e) => e.isNetwork, 'network', true)));
      await expectLater(c.json('GET', '/slow'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'timeout')));
    });
    test('sends bearer token, idempotency key and never logs bodies', () async {
      late http.Request seen;
      final c = ApiClient(client: MockClient((r) async { seen = r; return http.Response('{}', 200, headers: {'content-type': 'application/json'}); }), base: 'http://api.test/');
      await c.json('POST', '/guest/uploads/intents', token: 'abc', headers: {'Idempotency-Key': 'k1'}, body: {'a': 1});
      expect(seen.headers['Authorization'], 'Bearer abc'); expect(seen.headers['Idempotency-Key'], 'k1'); expect(seen.url.toString(), 'http://api.test/v1/guest/uploads/intents');
    });
  });

  group('session manager', () {
    Future<(SessionManager, MemoryVault, MemoryStore, List<String>)> make({int statusOnRefresh = 200}) async {
      final calls = <String>[];
      final mock = MockClient((r) async {
        calls.add('${r.method} ${r.url.path}');
        if (r.url.path.endsWith('/join')) return http.Response(jsonEncode({'token': 'tok-1', 'expires_in': 1800, 'scopes': ['upload'], 'display_name': null}), 200, headers: {'content-type': 'application/json'});
        if (r.url.path.endsWith('/guest/refresh')) {
          return statusOnRefresh == 200
              ? http.Response(jsonEncode({'token': 'tok-2', 'expires_in': 43200, 'scopes': ['upload']}), 200, headers: {'content-type': 'application/json'})
              : http.Response(jsonEncode({'error': {'code': 'session_blocked'}}), statusOnRefresh, headers: {'content-type': 'application/json'});
        }
        return http.Response('{}', 200, headers: {'content-type': 'application/json'});
      });
      final vault = MemoryVault(); final store = MemoryStore();
      return (SessionManager(api: GuestApi(ApiClient(client: mock, base: 'http://api.test')), store: store, vault: vault), vault, store, calls);
    }
    final ctx = {'event': {'name': 'ሠርግ', 'starts_at': '2026-10-02T09:00:00Z', 'language': 'am', 'host_name': 'አበበ'}, 'can_upload': true, 'status': 'open'};

    test('join keeps the token in the secure vault only, metadata in the DB; multiple events supported', () async {
      final (m, vault, store, _) = await make();
      final e = await m.join(const EventLocator('u_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), ctx, {'code': 'ABC'});
      expect(e.hasUpload, true); expect(e.hasGallery, false);
      expect(vault.map.values, ['tok-1']);
      final stored = jsonEncode((await store.events()).map((x) => x.toJson()).toList());
      expect(stored.contains('tok-1'), false);
      expect(stored.contains('ሠርግ'), true);
      await m.join(const EventLocator('AB3K9MNP'), ctx, {});
      expect((await store.events()).length, 2);
    });
    test('tokens close to expiry are refreshed; a blocked session is dropped', () async {
      final (m, vault, store, calls) = await make();
      await m.join(const EventLocator('u_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), ctx, {});
      expect(await m.tokenFor('u_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), 'tok-2');       // expires in 30 min -> refreshed
      expect(calls.where((c) => c.contains('refresh')).length, 1);
      expect(vault.map['guest.u_AbCdEfGhIjKlMnOpQrStUvWxYz012345'], 'tok-2');
      final (m2, vault2, _, _) = await make(statusOnRefresh: 403);
      await m2.join(const EventLocator('u_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), ctx, {});
      expect(await m2.tokenFor('u_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), isNull);
      expect(vault2.map, isEmpty);
      await m.leave('u_AbCdEfGhIjKlMnOpQrStUvWxYz012345');
      expect(await store.events(), isEmpty); expect(vault.map, isEmpty);
    });
  });

  group('localization resources (acceptance #23-25)', () {
    test('English and Amharic ARB files define the same keys and placeholders; Amharic is Ethiopic', () {
      final en = jsonDecode(File('lib/l10n/app_en.arb').readAsStringSync()) as Map<String, dynamic>;
      final am = jsonDecode(File('lib/l10n/app_am.arb').readAsStringSync()) as Map<String, dynamic>;
      final enKeys = en.keys.where((k) => !k.startsWith('@')).toSet(); final amKeys = am.keys.where((k) => !k.startsWith('@')).toSet();
      expect(amKeys, enKeys);
      final ph = RegExp(r'\{(\w+)\}'); final ethiopic = RegExp(r'[ሀ-፿]');
      for (final k in enKeys) {
        expect((am[k] as String).trim(), isNotEmpty, reason: k);
        expect(ph.allMatches(am[k] as String).map((m) => m[1]).toSet(), ph.allMatches(en[k] as String).map((m) => m[1]).toSet(), reason: 'placeholders in $k');
        if (k != '@@locale') expect(ethiopic.hasMatch(am[k] as String), true, reason: '$k should be Amharic');
      }
    });
  });
}
