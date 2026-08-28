import 'dart:math' as math;
import 'dart:typed_data';

/// Deterministic IRA-LDPC implementation compatible with GridData's web codec.
/// It intentionally uses the same Mulberry32 wiring algorithm, so the sender and
/// Android receiver build an identical Tanner graph from only k and m.
class LdpcCode {
  const LdpcCode({
    required this.k,
    required this.m,
    required this.messageChecks,
    required this.checkMessages,
  });

  final int k;
  final int m;
  final List<List<int>> messageChecks;
  final List<List<int>> checkMessages;
  int get n => k + m;
}

const _u32Mask = 0xffffffff;

int _u32(int value) => value & _u32Mask;
int _imul(int a, int b) => _u32(a * b);

double _tanh(double x) {
  if (x > 20) return 1;
  if (x < -20) return -1;
  final e = math.exp(2 * x);
  return (e - 1) / (e + 1);
}

double _atanh(double x) => 0.5 * math.log((1 + x) / (1 - x));

class _Mulberry32 {
  _Mulberry32(this._state);
  int _state;

  double next() {
    _state = _u32(_state + 0x6d2b79f5);
    var value = _imul(_state ^ (_state >> 15), 1 | _state);
    value = _u32(value + _imul(value ^ (value >> 7), 61 | value)) ^ value;
    return _u32(value ^ (value >> 14)) / 4294967296.0;
  }
}

LdpcCode makeLdpcKm(int k, int m, {int degree = 3}) {
  if (k < 1 || m < 1 || degree < 1) {
    throw ArgumentError('k, m and degree must be positive');
  }
  final checks = List<List<int>>.generate(m, (_) => <int>[]);
  final messages = List<List<int>>.generate(k, (_) => <int>[]);
  final random = _Mulberry32(_u32((k * 2654435761) ^ (m * 40503) ^ (degree * 668265263)));
  for (var bit = 0; bit < k; bit++) {
    final used = <int>{};
    for (var edge = 0; edge < degree; edge++) {
      var check = 0;
      var tries = 0;
      do {
        check = (random.next() * m).floor();
        tries++;
      } while (used.contains(check) && tries < 20);
      used.add(check);
      messages[bit].add(check);
      checks[check].add(bit);
    }
  }
  return LdpcCode(k: k, m: m, messageChecks: messages, checkMessages: checks);
}

Uint8List encodeParity(LdpcCode code, Uint8List message) {
  if (message.length < code.k) throw ArgumentError('Message is shorter than k');
  final parity = Uint8List(code.m);
  var previous = 0;
  for (var check = 0; check < code.m; check++) {
    var accumulated = 0;
    for (final bit in code.checkMessages[check]) {
      accumulated ^= message[bit] & 1;
    }
    previous = accumulated ^ previous;
    parity[check] = previous;
  }
  return parity;
}

/// Sum-product belief propagation. Positive LLR means the optical channel
/// favours a zero bit, exactly as in the browser implementation.
Uint8List decode(LdpcCode code, Float64List llr, {int iterations = 24}) {
  if (llr.length < code.n) throw ArgumentError('LLR vector is shorter than codeword');
  final checkVars = List<List<int>>.generate(code.m, (check) {
    final row = <int>[...code.checkMessages[check], code.k + check];
    if (check > 0) row.add(code.k + check - 1);
    return row;
  });
  final degrees = Int32List(code.n);
  for (final row in checkVars) {
    for (final variable in row) {
      degrees[variable]++;
    }
  }
  final variableChecks = List<List<int>>.generate(code.n, (i) => List<int>.filled(degrees[i], 0));
  final variablePositions = List<List<int>>.generate(code.n, (i) => List<int>.filled(degrees[i], 0));
  final fills = Int32List(code.n);
  for (var check = 0; check < checkVars.length; check++) {
    final row = checkVars[check];
    for (var position = 0; position < row.length; position++) {
      final variable = row[position];
      final slot = fills[variable]++;
      variableChecks[variable][slot] = check;
      variablePositions[variable][slot] = position;
    }
  }
  final messagesVc = checkVars.map((row) => Float64List(row.length)).toList();
  final messagesCv = checkVars.map((row) => Float64List(row.length)).toList();
  for (var check = 0; check < checkVars.length; check++) {
    final row = checkVars[check];
    for (var position = 0; position < row.length; position++) {
      messagesVc[check][position] = llr[row[position]];
    }
  }

  var maxDegree = 0;
  for (final row in checkVars) {
    maxDegree = math.max(maxDegree, row.length);
  }
  final tanhValues = Float64List(maxDegree);
  final prefix = Float64List(maxDegree);
  final hard = Uint8List(code.n);
  for (var iteration = 0; iteration < iterations; iteration++) {
    for (var check = 0; check < checkVars.length; check++) {
      final incoming = messagesVc[check];
      final outgoing = messagesCv[check];
      for (var i = 0; i < incoming.length; i++) {
        tanhValues[i] = _tanh(incoming[i] * 0.5);
      }
      var product = 1.0;
      for (var i = 0; i < incoming.length; i++) {
        prefix[i] = product;
        product *= tanhValues[i];
      }
      var suffix = 1.0;
      for (var i = incoming.length - 1; i >= 0; i--) {
        var withoutSelf = prefix[i] * suffix;
        if (withoutSelf > 0.999999999) {
          withoutSelf = 0.999999999;
        } else if (withoutSelf < -0.999999999) {
          withoutSelf = -0.999999999;
        }
        outgoing[i] = 2 * _atanh(withoutSelf);
        suffix *= tanhValues[i];
      }
    }
    for (var variable = 0; variable < code.n; variable++) {
      final checks = variableChecks[variable];
      final positions = variablePositions[variable];
      var total = llr[variable];
      for (var edge = 0; edge < checks.length; edge++) {
        total += messagesCv[checks[edge]][positions[edge]];
      }
      hard[variable] = total < 0 ? 1 : 0;
      for (var edge = 0; edge < checks.length; edge++) {
        final check = checks[edge];
        final position = positions[edge];
        messagesVc[check][position] = total - messagesCv[check][position];
      }
    }
    var valid = true;
    for (final row in checkVars) {
      var parity = 0;
      for (final variable in row) {
        parity ^= hard[variable];
      }
      if (parity != 0) {
        valid = false;
        break;
      }
    }
    if (valid) break;
  }
  return Uint8List.fromList(hard.sublist(0, code.k));
}
