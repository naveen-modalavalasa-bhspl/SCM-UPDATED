// @ts-nocheck
import React, { useState, useRef, useEffect } from 'react';
import { Input, Button, Space, Switch, Typography } from 'antd';
import { ScanOutlined, EditOutlined } from '@ant-design/icons';

const { Text } = Typography;

const BarcodeScanner = ({
  onScan,
  placeholder = 'Scan barcode here...',
  autoFocus = true,
  disabled = false,
  allowManual = true,
}) => {
  const [value, setValue] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault();
      const scanResult = {
        value: value.trim(),
        timestamp: new Date().toISOString(),
        mode: manualMode ? 'manual' : 'scan',
      };
      setLastScan(scanResult);
      if (onScan) {
        onScan(scanResult);
      }
      setValue('');
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  };

  const handleManualSubmit = () => {
    if (value.trim()) {
      const scanResult = {
        value: value.trim(),
        timestamp: new Date().toISOString(),
        mode: 'manual',
      };
      setLastScan(scanResult);
      if (onScan) {
        onScan(scanResult);
      }
      setValue('');
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  };

  return (
    <div>
      <div className="barcode-scanner-input">
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space align="center">
            <ScanOutlined style={{ fontSize: 20, color: '#eb2f96' }} />
            <Text strong style={{ fontSize: 14 }}>
              {manualMode ? 'Manual Entry Mode' : 'Scanner Mode'}
            </Text>
            {allowManual && (
              <Switch
                checkedChildren={<EditOutlined />}
                unCheckedChildren={<ScanOutlined />}
                checked={manualMode}
                onChange={setManualMode}
                size="small"
              />
            )}
          </Space>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              size="large"
              autoFocus={autoFocus}
              style={{
                fontSize: 18,
                textAlign: 'center',
                fontWeight: 600,
                letterSpacing: 2,
              }}
            />
            {manualMode && (
              <Button
                type="primary"
                size="large"
                onClick={handleManualSubmit}
                disabled={!value.trim()}
              >
                Submit
              </Button>
            )}
          </Space.Compact>
          {lastScan && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Last scan: {lastScan.value} at{' '}
              {new Date(lastScan.timestamp).toLocaleTimeString()}
            </Text>
          )}
        </Space>
      </div>
    </div>
  );
};

export default BarcodeScanner;
