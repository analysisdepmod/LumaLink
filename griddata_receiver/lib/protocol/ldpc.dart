import 'dart:typed_data';

/// Deterministic IRA-LDPC implementation compatible with GridData's web codec.
/// It intentionally uses the same Mulberry32 wiring algorithm, so the sender and
/// Android receiver build an identical Tanner graph from only k and m.
class LdpcCode {
  LdpcCode({
    required this.k,
    required this.m,
    required this.messageChecks,
    required this.checkMessages,
  });

  final int k;
  final int m;
  final List<List<int>> messageChecks;
  final List<List<int>> checkMessages;
  _LdpcDecodePlan? decodePlan;
  int get n => k + m;
}

const _u32Mask = 0xffffffff;

int _u32(int value) => value & _u32Mask;
int _imul(int a, int b) => _u32(a * b);

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
  final random = _Mulberry32(
    _u32((k * 2654435761) ^ (m * 40503) ^ (degree * 668265263)),
  );
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

class _LdpcDecodePlan {
  _LdpcDecodePlan({
    required this.checkVars,
    required this.variableChecks,
    required this.variablePositions,
    required this.messagesVc,
    required this.messagesCv,
    required this.hard,
  });
  final List<List<int>> checkVars;
  final List<List<int>> variableChecks;
  final List<List<int>> variablePositions;
  final List<Float32List> messagesVc;
  final List<Float32List> messagesCv;
  final Uint8List hard;
}

_LdpcDecodePlan _makeDecodePlan(LdpcCode code) {
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
  final variableChecks = List<List<int>>.generate(
    code.n,
    (i) => List<int>.filled(degrees[i], 0),
  );
  final variablePositions = List<List<int>>.generate(
    code.n,
    (i) => List<int>.filled(degrees[i], 0),
  );
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
  return _LdpcDecodePlan(
    checkVars: checkVars,
    variableChecks: variableChecks,
    variablePositions: variablePositions,
    messagesVc: checkVars.map((row) => Float32List(row.length)).toList(),
    messagesCv: checkVars.map((row) => Float32List(row.length)).toList(),
    hard: Uint8List(code.n),
  );
}

/// Normalized min-sum belief propagation, matching the browser's WebAssembly
/// decoder. It avoids exp/log/tanh in the old sum-product path and reuses the
/// immutable Tanner graph plus working buffers between camera frames.
Uint8List decode(LdpcCode code, Float64List llr, {int iterations = 24}) {
  if (llr.length < code.n)
    throw ArgumentError('LLR vector is shorter than codeword');
  final plan = code.decodePlan ??= _makeDecodePlan(code);
  final checkVars = plan.checkVars;
  final messagesVc = plan.messagesVc;
  final messagesCv = plan.messagesCv;
  for (var check = 0; check < checkVars.length; check++) {
    final row = checkVars[check];
    for (var position = 0; position < row.length; position++) {
      messagesVc[check][position] = llr[row[position]];
    }
  }
  const alpha = 0.9;
  final hard = plan.hard;
  for (var iteration = 0; iteration < iterations; iteration++) {
    for (var check = 0; check < checkVars.length; check++) {
      final incoming = messagesVc[check];
      final outgoing = messagesCv[check];
      var sign = 1.0;
      var minimum = double.infinity;
      var secondMinimum = double.infinity;
      var minimumIndex = -1;
      for (var i = 0; i < incoming.length; i++) {
        final value = incoming[i];
        if (value < 0) sign = -sign;
        final magnitude = value.abs();
        if (magnitude < minimum) {
          secondMinimum = minimum;
          minimum = magnitude;
          minimumIndex = i;
        } else if (magnitude < secondMinimum) {
          secondMinimum = magnitude;
        }
      }
      for (var i = 0; i < incoming.length; i++) {
        final magnitude = i == minimumIndex ? secondMinimum : minimum;
        final ownSign = incoming[i] < 0 ? -1.0 : 1.0;
        outgoing[i] = alpha * sign * ownSign * magnitude;
      }
    }
    for (var variable = 0; variable < code.n; variable++) {
      final checks = plan.variableChecks[variable];
      final positions = plan.variablePositions[variable];
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
