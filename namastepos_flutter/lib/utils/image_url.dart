// Shared image-URL resolver (2026-08-22).
//
// Menu images are stored as relative `/uploads/...` paths by the backend
// upload route. Rendering them needs the API origin prefixed. Keep this
// in ONE place so POS, menu editor and future screens agree.

import '../services/api_service.dart';

String fullImageUrl(String url) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/uploads')) {
    return '${ApiService.baseUrl.replaceAll("/v1", "")}$url';
  }
  return url;
}
