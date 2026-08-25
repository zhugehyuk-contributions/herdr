// Ported from orca mobile/src/components/ConfirmModal.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Changed for herdr, for the reason `./ActionSheetModal.tsx`'s header states: every text style
// names a JetBrains Mono face instead of a `fontWeight`, which Android does not synthesise for a
// custom family. Palette still orca's; this drawer is not mounted by a herdr screen yet.
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, spacing, radii } from '../theme/mobile-theme'
import { typography } from '../theme/herdr-typography'
import { BottomDrawer } from './BottomDrawer'

type Props = {
  visible: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: Props) {
  return (
    <BottomDrawer visible={visible} onClose={onCancel}>
      <View style={styles.content}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
      <View style={styles.buttons}>
        <Pressable
          style={({ pressed }) => [styles.button, styles.cancelButton, pressed && styles.pressed]}
          onPress={onCancel}
        >
          <Text style={styles.cancelText}>{cancelLabel}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.button,
            destructive ? styles.destructiveButton : styles.confirmButton,
            pressed && styles.pressed
          ]}
          onPress={() => {
            onConfirm()
            onCancel()
          }}
        >
          <Text style={destructive ? styles.destructiveText : styles.confirmText}>
            {confirmLabel}
          </Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.lg
  },
  title: {
    fontSize: 16,
    fontFamily: typography.monoFamilyBold,
    color: colors.textPrimary
  },
  message: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20,
    fontFamily: typography.monoFamily
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  button: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  cancelButton: {
    backgroundColor: colors.bgPanel
  },
  confirmButton: {
    backgroundColor: colors.textPrimary
  },
  destructiveButton: {
    backgroundColor: colors.statusRed
  },
  pressed: {
    opacity: 0.7
  },
  cancelText: {
    fontSize: typography.bodySize,
    fontFamily: typography.monoFamilySemiBold,
    color: colors.textSecondary
  },
  confirmText: {
    fontSize: typography.bodySize,
    fontFamily: typography.monoFamilySemiBold,
    color: colors.bgBase
  },
  destructiveText: {
    fontSize: typography.bodySize,
    fontFamily: typography.monoFamilySemiBold,
    color: '#fff'
  }
})
