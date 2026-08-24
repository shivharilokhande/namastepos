// Unit tests for humanizeError (FF-220 + FF-260).
//
// Pure-Dart function → no widget test binding needed. Covers each
// DioException type + generic Exception fallback.

import 'dart:io' show SocketException;
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:namastepos/services/api_service.dart' show ApiException;
import 'package:namastepos/utils/error_humanizer.dart';

void main() {
  group('humanizeError', () {
    test('connection timeout → slow connection message', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.connectionTimeout,
      );
      expect(humanizeError(e), contains('slow'));
    });

    test('connection error → offline message', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.connectionError,
      );
      expect(humanizeError(e), contains('offline'));
    });

    test('HTTP 401 → sign in again', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.badResponse,
        response: Response(
          requestOptions: RequestOptions(path: '/x'),
          statusCode: 401,
        ),
      );
      expect(humanizeError(e).toLowerCase(), contains('sign'));
    });

    test('HTTP 402 → plan upgrade prompt', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.badResponse,
        response: Response(
          requestOptions: RequestOptions(path: '/x'),
          statusCode: 402,
        ),
      );
      expect(humanizeError(e).toLowerCase(), contains('plan'));
    });

    test('HTTP 429 → slow down message', () {
      final e = DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.badResponse,
        response: Response(
          requestOptions: RequestOptions(path: '/x'),
          statusCode: 429,
        ),
      );
      expect(humanizeError(e).toLowerCase(), contains('slow'));
    });

    test('HTTP 5xx → server issue', () {
      for (final code in [500, 502, 503, 504]) {
        final e = DioException(
          requestOptions: RequestOptions(path: '/x'),
          type: DioExceptionType.badResponse,
          response: Response(
            requestOptions: RequestOptions(path: '/x'),
            statusCode: code,
          ),
        );
        expect(humanizeError(e).toLowerCase(), contains('server issue'),
            reason: 'code $code should map to server issue');
      }
    });

    test('ApiException wraps + reuses status', () {
      final e = ApiException('Missing name', 400);
      // Backend message wins for 400.
      expect(humanizeError(e), contains('Missing name'));
    });

    test('SocketException → offline', () {
      expect(humanizeError(const SocketException('boom')),
          contains('offline'));
    });

    test('arbitrary Exception → generic', () {
      expect(humanizeError(Exception('boom')),
          contains('Something went wrong'));
    });
  });
}
