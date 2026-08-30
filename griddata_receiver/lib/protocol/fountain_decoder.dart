import 'dart:math' as math;
import 'dart:typed_data';

const _u32Mask = 0xffffffff;
int _u32(int value) => value & _u32Mask;
int _imul(int a, int b) => _u32(a * b);

class _FountainRandom {
  _FountainRandom(this._state);
  int _state;

  int nextUint() {
    _state = _u32(_state + 0x6d2b79f5);
    var value = _state;
    value = _imul(value ^ (value >> 15), value | 1);
    value = _u32(value ^ _u32(value + _imul(value ^ (value >> 7), value | 61)));
    return _u32(value ^ (value >> 14));
  }

  double nextDouble() => nextUint() / 4294967296.0;
}

final Map<int, List<double>> _cdfCache = <int, List<double>>{};

List<double> _cdf(int k) => _cdfCache.putIfAbsent(k, () {
  const c = 0.03;
  const delta = 0.5;
  final mu = List<double>.filled(k, 0);
  final s = c * math.log(k / delta) * math.sqrt(k);
  final threshold = math.max(1, (k / s).round());
  var normalizer = 0.0;
  for (var i = 0; i < k; i++) {
    final degree = i + 1;
    final rho = degree == 1 ? 1 / k : 1 / (degree * (degree - 1));
    final tau = degree < threshold
        ? s / (degree * k)
        : (degree == threshold ? s * math.log(s / delta) / k : 0.0);
    mu[i] = rho + tau;
    normalizer += mu[i];
  }
  var running = 0.0;
  final result = List<double>.filled(k, 0);
  for (var i = 0; i < k; i++) {
    running += mu[i] / normalizer;
    result[i] = running;
  }
  result[k - 1] = 1;
  return result;
});

int _degree(double random, int k) {
  final cdf = _cdf(k);
  var low = 0;
  var high = cdf.length - 1;
  while (low < high) {
    final middle = (low + high) >> 1;
    if (random < cdf[middle]) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low + 1;
}

List<int> sourceIndices(int seed, int k, {int mediumWideEvery = 2}) {
  if (seed >= 1 && seed <= k) return <int>[seed - 1];
  final random = _FountainRandom(seed & _u32Mask);
  final repairOrdinal = seed - k;
  final degree = mediumWideEvery > 0 && repairOrdinal % mediumWideEvery == 0
      ? math.min(32, k)
      : _degree(random.nextDouble(), k);
  if (degree >= k) return List<int>.generate(k, (i) => i);
  final seen = <int>{};
  final result = <int>[];
  while (result.length < degree) {
    var index = (random.nextDouble() * k).floor();
    if (index >= k) index = k - 1;
    if (seen.add(index)) result.add(index);
  }
  return result;
}

void _xor(Uint8List target, Uint8List source) {
  final length = math.min(target.length, source.length);
  for (var i = 0; i < length; i++) {
    target[i] ^= source[i];
  }
}

class _PendingEquation {
  _PendingEquation(this.data, this.remaining);
  final Uint8List data;
  final Set<int> remaining;
}

/// Streaming LT/fountain peel decoder compatible with GridData's systematic
/// schedule. Frames may arrive out of order; duplicate seeds cost nothing.
class FountainDecoder {
  FountainDecoder(this.k, this.chunkSize, {this.mediumWideEvery = 2})
    : _decoded = List<Uint8List?>.filled(k, null);

  final int k;
  final int chunkSize;
  final int mediumWideEvery;
  final List<Uint8List?> _decoded;
  final Map<int, _PendingEquation> _pending = <int, _PendingEquation>{};
  final Map<int, Set<int>> _bySource = <int, Set<int>>{};
  final Set<int> _seenSeeds = <int>{};
  var _decodedCount = 0;
  var _nextEquation = 0;
  var _tailTicks = 0;
  var tailSolverAttempts = 0;
  var tailSolverChunks = 0;

  bool get isComplete => _decodedCount >= k;
  int get uniqueChunks => _decodedCount;
  int get receivedEquations => _seenSeeds.length;

  bool addFrame(int seed, Uint8List data) {
    if (isComplete) return true;
    if (!_seenSeeds.add(seed)) return false;
    final payload = Uint8List(chunkSize)
      ..setRange(0, math.min(chunkSize, data.length), data);
    final remaining = <int>{};
    for (final index in sourceIndices(
      seed,
      k,
      mediumWideEvery: mediumWideEvery,
    )) {
      final known = _decoded[index];
      if (known == null) {
        remaining.add(index);
      } else {
        _xor(payload, known);
      }
    }
    if (remaining.isEmpty) return false;
    final id = _nextEquation++;
    _pending[id] = _PendingEquation(payload, remaining);
    for (final index in remaining) {
      (_bySource[index] ??= <int>{}).add(id);
    }
    _propagate(id);
    if (!isComplete) _tryDenseTail();
    return true;
  }

  void _tryDenseTail() {
    final missing = <int>[
      for (var i = 0; i < k; i++)
        if (_decoded[i] == null) i,
    ];
    if (missing.length > 128 ||
        _pending.length < missing.length ||
        (++_tailTicks & 3) != 0)
      return;
    tailSolverAttempts++;
    final position = <int, int>{
      for (var i = 0; i < missing.length; i++) missing[i]: i,
    };
    final masks = <BigInt>[];
    final values = <Uint8List>[];
    for (final equation in _pending.values) {
      var mask = BigInt.zero;
      for (final source in equation.remaining) {
        final bit = position[source];
        if (bit != null) mask |= BigInt.one << bit;
      }
      if (mask != BigInt.zero) {
        masks.add(mask);
        values.add(Uint8List.fromList(equation.data));
      }
    }
    var pivotRow = 0;
    final pivotForColumn = List<int>.filled(missing.length, -1);
    for (
      var column = 0;
      column < missing.length && pivotRow < masks.length;
      column++
    ) {
      var found = pivotRow;
      while (found < masks.length &&
          (masks[found] & (BigInt.one << column)) == BigInt.zero) {
        found++;
      }
      if (found == masks.length) continue;
      if (found != pivotRow) {
        final mask = masks[pivotRow];
        masks[pivotRow] = masks[found];
        masks[found] = mask;
        final value = values[pivotRow];
        values[pivotRow] = values[found];
        values[found] = value;
      }
      for (var row = 0; row < masks.length; row++) {
        if (row == pivotRow ||
            (masks[row] & (BigInt.one << column)) == BigInt.zero)
          continue;
        masks[row] ^= masks[pivotRow];
        _xor(values[row], values[pivotRow]);
      }
      pivotForColumn[column] = pivotRow++;
    }
    if (pivotForColumn.any((row) => row < 0)) return;
    for (var column = 0; column < missing.length; column++) {
      _decoded[missing[column]] = values[pivotForColumn[column]];
    }
    _decodedCount += missing.length;
    tailSolverChunks += missing.length;
    _pending.clear();
    _bySource.clear();
  }

  void _propagate(int firstId) {
    final queue = <int>[];
    if (_pending[firstId]?.remaining.length == 1) queue.add(firstId);
    while (queue.isNotEmpty) {
      final id = queue.removeLast();
      final equation = _pending[id];
      if (equation == null || equation.remaining.length != 1) continue;
      final source = equation.remaining.first;
      if (_decoded[source] != null) continue;
      final value = equation.data;
      _decoded[source] = value;
      _decodedCount++;
      _pending.remove(id);
      _bySource[source]?.remove(id);
      final references = List<int>.from(_bySource[source] ?? const <int>{});
      for (final otherId in references) {
        final other = _pending[otherId];
        if (other == null) continue;
        _xor(other.data, value);
        other.remaining.remove(source);
        if (other.remaining.length == 1) queue.add(otherId);
        if (other.remaining.isEmpty) _pending.remove(otherId);
      }
      _bySource.remove(source);
      if (isComplete) return;
    }
  }

  Uint8List reconstruct() {
    if (!isComplete) throw StateError('Transfer is incomplete');
    final output = Uint8List(k * chunkSize);
    for (var i = 0; i < k; i++) {
      output.setRange(i * chunkSize, (i + 1) * chunkSize, _decoded[i]!);
    }
    return output;
  }
}
