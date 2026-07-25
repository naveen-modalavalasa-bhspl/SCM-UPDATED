// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, Row, Col, Table, Card,
  Divider, Typography, Badge, message
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, PlusOutlined,
  MinusCircleOutlined, InboxOutlined, SendOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import ItemSelector from '../components/ItemSelector';
import api from '../config/api';
import { getErrorMessage } from '../utils/helpers';

const { Text } = Typography;

const PICK_STRATEGIES = [
  { label: 'FIFO', value: 'fifo' },
  { label: 'FEFO', value: 'fefo' },
  { label: 'LIFO', value: 'lifo' },
  { label: 'Manual', value: 'manual' },
];

const PicklistForm = () => {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  // Form selections and lookups
  const [pickItems, setPickItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [doOptions, setDoOptions] = useState([]);
  const [waveOptions, setWaveOptions] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);
  const [userOptions, setUserOptions] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [whRes, uomRes, userRes, doRes, waveRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
        api.get('/users/lookup', { params: { page_size: 200 } }),
        api.get('/outbound/delivery-orders', { params: { page_size: 100 } }),
        api.get('/outbound/wave-plans', { params: { page_size: 100 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        setUomOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.code || i.name,
            value: i.id,
          }))
        );
      }
      if (userRes.status === 'fulfilled') {
        const us = userRes.value.data;
        setUserOptions(
          (us.items || us.data || us || []).map((i) => ({
            label: i.full_name || i.username || `${i.first_name || ''} ${i.last_name || ''}`.trim(),
            value: i.id,
          }))
        );
      }
      if (doRes.status === 'fulfilled') {
        const d = doRes.value.data;
        setDoOptions(
          (d.items || d.data || d || []).map((i) => ({
            label: i.do_number || `DO-${i.id}`,
            value: i.id,
          }))
        );
      }
      if (waveRes.status === 'fulfilled') {
        const w = waveRes.value.data;
        setWaveOptions(
          (w.items || w.data || w || []).map((i) => ({
            label: i.wave_number || `WAVE-${i.id}`,
            value: i.id,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLookups();
    // Initialize with strategy FIFO
    form.setFieldsValue({ pick_strategy: 'fifo' });
  }, [loadLookups, form]);

  const addPickItem = () => {
    setPickItems((prev) => [
      ...prev,
      {
        key: Date.now() + Math.random(),
        item_id: null,
        item_name: '',
        item_code: '',
        batch_id: null,
        from_bin_id: null,
        qty_to_pick: 1,
        uom_id: null,
      },
    ]);
  };

  const removePickItem = (key) => {
    setPickItems((prev) => prev.filter((i) => i.key !== key));
  };

  const updatePickItem = (key, patch) => {
    setPickItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (!pickItems.length) {
        message.error('Add at least one item to pick');
        return;
      }
      const invalid = pickItems.find(
        (i) => !i.item_id || !i.from_bin_id || !i.qty_to_pick || !i.uom_id
      );
      if (invalid) {
        message.error('Each item needs: item, from-bin, qty, UoM');
        return;
      }
      setSubmitting(true);
      const payload = {
        warehouse_id: values.warehouse_id,
        pick_strategy: values.pick_strategy || 'fifo',
        wave_id: values.wave_id || null,
        do_id: values.do_id || null,
        assigned_to: values.assigned_to || null,
        items: pickItems.map((i) => ({
          item_id: i.item_id,
          batch_id: i.batch_id || null,
          from_bin_id: i.from_bin_id,
          qty_to_pick: Number(i.qty_to_pick),
          uom_id: i.uom_id,
        })),
      };
      const res = await api.post('/outbound/picking-orders', payload);
      message.success(`Pick list ${res.data?.pick_number || ''} generated`);
      navigate('/warehouse/picklist');
    } catch (err) {
      if (err?.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const createItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      width: 260,
      render: (_, row) => (
        <ItemSelector
          value={row.item_id}
          onChange={(val, opt) =>
            updatePickItem(row.key, {
              item_id: val,
              item_name: opt?.label || opt?.name || '',
              item_code: opt?.code || '',
              uom_id: opt?.default_uom_id || row.uom_id,
            })
          }
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Batch ID',
      width: 110,
      render: (_, row) => (
        <InputNumber
          value={row.batch_id}
          onChange={(v) => updatePickItem(row.key, { batch_id: v })}
          placeholder="optional"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'From Bin ID',
      width: 120,
      render: (_, row) => (
        <InputNumber
          value={row.from_bin_id}
          onChange={(v) => updatePickItem(row.key, { from_bin_id: v })}
          placeholder="bin id"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Qty',
      width: 100,
      render: (_, row) => (
        <InputNumber
          min={0.0001}
          value={row.qty_to_pick}
          onChange={(v) => updatePickItem(row.key, { qty_to_pick: v })}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'UoM',
      width: 130,
      render: (_, row) => (
        <Select
          options={uomOptions}
          value={row.uom_id}
          onChange={(v) => updatePickItem(row.key, { uom_id: v })}
          showSearch
          optionFilterProp="label"
          placeholder="UoM"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: '',
      width: 50,
      render: (_, row) => (
        <Button
          type="text"
          danger
          icon={<MinusCircleOutlined />}
          onClick={() => removePickItem(row.key)}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader 
        title="Generate Pick List" 
        subtitle="Configure picking settings and specify items to retrieve"
      >
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/warehouse/picklist')}>
            Back
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSubmit}
            loading={submitting}
          >
            Generate
          </Button>
        </Space>
      </PageHeader>

      <Card variant="borderless" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="warehouse_id"
                label="Warehouse"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="pick_strategy"
                label="Pick Strategy"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select options={PICK_STRATEGIES} placeholder="Strategy" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="assigned_to" label="Assign To (Picker)">
                <Select
                  options={userOptions}
                  placeholder="Select picker"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="do_id" label="Delivery Order (optional)">
                <Select
                  options={doOptions}
                  placeholder="Select DO"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="wave_id" label="Wave Plan (optional)">
                <Select
                  options={waveOptions}
                  placeholder="Select Wave"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left">
            <Space>
              <InboxOutlined />
              Items to Pick
              <Badge count={pickItems.length} style={{ backgroundColor: '#eb2f96' }} />
            </Space>
          </Divider>

          <Card size="small" style={{ marginBottom: 12 }}>
            <Button
              type="dashed"
              onClick={addPickItem}
              block
              icon={<PlusOutlined />}
            >
              Add Item
            </Button>
          </Card>

          <Table
            dataSource={pickItems}
            columns={createItemColumns}
            rowKey="key"
            pagination={false}
            size="small"
            scroll={{ x: 900 }}
            locale={{ emptyText: 'No items added yet — click "Add Item"' }}
          />
        </Form>
      </Card>
    </div>
  );
};

export default PicklistForm;
